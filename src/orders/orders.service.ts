import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { PubSub } from 'graphql-subscriptions';
import { Query, Timestamp } from 'firebase-admin/firestore';
import { FirestoreService } from '../firestore/firestore.service';
import {
  OrderDeliveryDoc,
  OrderDoc,
  OrderEventDoc,
  OrderItemDoc,
} from '../firestore/firestore.types';
import {
  DeliveryInput,
  DeliveryMethod,
  Order as GqlOrder,
  OrderContactInput,
  OrderPayment as GqlOrderPayment,
  OrderTracking as GqlOrderTracking,
  OrderActor,
  OrderStatus,
  PaymentStatus,
  PlaceOrderInput,
  Product,
} from '../graphql.schema';
import { getProduct, listProducts } from './catalogue';
import {
  CancelledInvoice,
  CreatedInvoice,
  InvoiceStatus,
  InvoiceStatusResponse,
  MonobankError,
  MonobankService,
  UAH,
} from './monobank.service';

/** How long a payment page stays open. */
const INVOICE_VALIDITY_SECONDS = 3 * 60 * 60;

/** Order ids are read aloud and typed in, so no 0/O/1/I. */
const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ID_LENGTH = 8;

/** The order can still be called off — nothing has left the building. */
const CANCELLABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.IN_ASSEMBLY,
];

/**
 * The address and the contact details can still be corrected.
 *
 * Stops one step earlier than cancelling, at `IN_ASSEMBLY`: from there the
 * waybill is being filled in by hand from what the order says, and an address
 * that changes between being read and being printed is a parcel going
 * somewhere nobody will look for it. Calling the order off is still fine — a
 * parcel that has not gone anywhere can be unpacked.
 */
const EDITABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
];

/** Newest orders, when the caller does not say how many they want. */
const DEFAULT_ORDER_PAGE = 50;

/** As many as one screen can usefully hold, and a bound on the read. */
const MAX_ORDER_PAGE = 200;

/**
 * The statuses a parcel can be dispatched from.
 *
 * `SHIPPED` is in the list on purpose: re-running the dispatch is how a
 * mistyped waybill number is corrected, and a typo is noticed after the fact
 * or not at all. `PENDING_PAYMENT` is not — handing over a parcel nobody has
 * paid for is a mistake worth refusing rather than recording.
 */
const SHIPPABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.IN_ASSEMBLY,
  OrderStatus.SHIPPED,
];

/**
 * Nova Poshta waybill numbers are fourteen digits.
 *
 * Checked because the number is typed off a printed sheet and a wrong one is
 * silent: the customer follows a parcel that is not theirs, or nothing at
 * all, and we hear about it when it does not arrive. Only Nova Poshta's
 * format is pinned — Ukrposhta numbers look nothing like this.
 */
const NOVA_POSHTA_TTN = /^\d{14}$/;

/** Long enough for any carrier's number, short enough not to be a paragraph. */
const MAX_TRACKING_NUMBER_LENGTH = 32;

const PAYMENT_STATUS_BY_INVOICE: Record<InvoiceStatus, PaymentStatus> = {
  created: PaymentStatus.CREATED,
  processing: PaymentStatus.PROCESSING,
  hold: PaymentStatus.HOLD,
  success: PaymentStatus.SUCCESS,
  failure: PaymentStatus.FAILURE,
  reversed: PaymentStatus.REVERSED,
  expired: PaymentStatus.EXPIRED,
};

/** A payment status no later webhook can move away from. */
const FINAL_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.SUCCESS,
  PaymentStatus.FAILURE,
  PaymentStatus.REVERSED,
  PaymentStatus.EXPIRED,
];

export const ORDER_UPDATES = 'orderUpdates';

interface AppliedStatus {
  order: GqlOrder | null;
  changed: boolean;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly pubSub = new PubSub();

  constructor(
    private readonly firestore: FirestoreService,
    private readonly monobank: MonobankService,
  ) {}

  getPubSub() {
    return this.pubSub;
  }

  // ─── Reading ──────────────────────────────────────────────────────────

  /** The catalogue the storefront prices from — the same one we charge from. */
  listProducts(): Product[] {
    return listProducts();
  }

  async getMyOrders(uid: string): Promise<GqlOrder[]> {
    const snapshot = await this.firestore.orders
      .where('ownerUid', '==', uid)
      .orderBy('createdAt', 'desc')
      .get();

    return snapshot.docs.map((doc) => this.toGqlOrder(doc.id, doc.data()));
  }

  async getOrder(id: string, uid: string): Promise<GqlOrder | null> {
    // Normalised like every other lookup: the order number reaches us from a
    // URL the customer may well have typed, and a lower-case one must find
    // the same order rather than look like a missing one.
    const doc = await this.firestore.orders.doc(normalizeOrderId(id)).get();
    if (!doc.exists) return null;

    const data = doc.data();
    if (data.ownerUid !== uid) {
      throw new ForbiddenException('This order belongs to someone else');
    }

    return this.toGqlOrder(doc.id, data);
  }

  /**
   * Lookup without an account, by order number and the phone on the order.
   *
   * Answers nothing an order number alone unlocks: without a matching phone
   * this is a null, so a guessed id leaks neither the amount nor the
   * customer's details.
   */
  async getOrderTracking(
    id: string,
    phone: string,
  ): Promise<GqlOrderTracking | null> {
    const doc = await this.firestore.orders.doc(normalizeOrderId(id)).get();
    if (!doc.exists) return null;

    const data = doc.data();
    const known = [data.contactPhone, data.delivery?.phone];
    if (!known.some((candidate) => samePhone(candidate, phone))) {
      return null;
    }

    return {
      id: doc.id,
      status: data.status,
      paymentStatus: data.paymentStatus,
      trackingNumber: data.trackingNumber,
      updatedAt: toIso(data.updatedAt ?? data.createdAt),
    };
  }

  // ─── Reading, as us ───────────────────────────────────────────────────
  // No owner check on either of these, so both are only ever reached from
  // behind `AdminGuard`. They are what makes dispatch a job somebody can do
  // at a desk: everything above answers about the caller's own orders, which
  // is no help when the order you have to pack belongs to a customer.

  /**
   * Orders across every customer, newest first.
   *
   * `status` is what makes it useful — `PAID` is the list of parcels waiting
   * to be put together, and `SHIPPED` the ones still out. Always bounded:
   * an unbounded read of a growing collection is a bill and a timeout.
   */
  async listOrders({
    status,
    limit,
  }: {
    status?: OrderStatus | null;
    limit?: number | null;
  } = {}): Promise<GqlOrder[]> {
    // The schema says `Int`, so this should already be whole and finite —
    // but a NaN reaching `.limit()` throws from inside Firestore, which is a
    // long way from the argument that caused it.
    const asked = Number(limit);
    const capped = Number.isFinite(asked)
      ? Math.min(Math.max(Math.trunc(asked), 1), MAX_ORDER_PAGE)
      : DEFAULT_ORDER_PAGE;

    const base: Query<OrderDoc> = status
      ? this.firestore.orders.where('status', '==', status)
      : this.firestore.orders;

    const snapshot = await base
      .orderBy('createdAt', 'desc')
      .limit(capped)
      .get();

    return snapshot.docs.map((doc) => this.toGqlOrder(doc.id, doc.data()));
  }

  /**
   * One order, whoever it belongs to.
   *
   * The address to copy onto the waybill lives here. `getOrder` answers only
   * about the caller's own, and `getOrderTracking` deliberately carries no
   * contact details, so without this the delivery details are reachable only
   * from the Firestore console.
   */
  async getAnyOrder(id: string): Promise<GqlOrder | null> {
    const doc = await this.firestore.orders.doc(normalizeOrderId(id)).get();
    if (!doc.exists) return null;

    return this.toGqlOrder(doc.id, doc.data());
  }

  // ─── Placing and paying ───────────────────────────────────────────────

  /**
   * Prices the basket, writes the order, and opens a monobank invoice for it.
   *
   * The order is written *before* the invoice exists so a monobank call that
   * succeeds but whose answer we never see still has somewhere to land: the
   * webhook carries our reference, and a customer is never charged for an
   * order we have no record of.
   *
   * An owner and an address are both required. There is no such thing here as
   * an order we cannot deliver or a customer we cannot reach — and a Tsutsyk
   * needs an account to be used at all, so the sign-in is a step the buyer
   * takes either way.
   */
  async placeOrder({
    input,
    uid,
    account,
    requestOrigin,
  }: {
    input: PlaceOrderInput;
    uid: string;
    account?: { email: string | null; phone: string | null };
    requestOrigin?: string | null;
  }): Promise<GqlOrderPayment> {
    this.assertAcquiringConfigured();

    const items = this.priceItems(input.items);
    const amount = items.reduce((total, item) => total + item.sum, 0);
    const redirectUrl = this.resolveRedirectUrl(input.redirectUrl);

    if (!input.delivery) {
      throw new BadRequestException('An order needs delivery details');
    }

    const delivery = toDeliveryDoc(input.delivery);
    assertDeliverable(delivery);

    if (input.contact?.phone && !isPlausiblePhone(input.contact.phone)) {
      throw new BadRequestException('That does not look like a phone number');
    }

    const now = Timestamp.now();
    // Whoever we should call about this order. The delivery phone may be the
    // recipient's rather than the buyer's, so an explicit contact wins, and
    // the account's own verified number is the last word.
    const phone = input.contact?.phone ?? account?.phone ?? delivery.phone;
    const contactPhone = normalizePhone(phone);

    const order: OrderDoc = {
      ownerUid: uid,
      contactPhone,
      contactEmail: input.contact?.email ?? account?.email ?? null,
      items,
      amount,
      currency: UAH,
      status: OrderStatus.PENDING_PAYMENT,
      paymentStatus: null,
      invoiceId: null,
      paymentPageUrl: null,
      paymentModifiedDate: null,
      failureReason: null,
      cancelReason: null,
      delivery,
      trackingNumber: null,
      tsutsykIds: [],
      events: [
        {
          at: now,
          status: OrderStatus.PENDING_PAYMENT,
          actor: OrderActor.CUSTOMER,
          note: 'Замовлення створено',
        },
      ],
      createdAt: now,
      updatedAt: now,
      paidAt: null,
    };

    const id = await this.createWithFreshId(order);

    return this.openInvoice({ id, order, redirectUrl, requestOrigin });
  }

  /**
   * A second (third, tenth) invoice for an order nobody has paid for.
   *
   * Invoices expire — three hours by default — and `expired` is the one status
   * monobank never sends a webhook for, so an abandoned checkout would
   * otherwise leave the customer with an order they cannot pay and no way
   * back to it.
   */
  async retryOrderPayment({
    orderId,
    uid,
    redirectUrl,
    requestOrigin,
  }: {
    orderId: string;
    uid: string;
    redirectUrl?: string | null;
    requestOrigin?: string | null;
  }): Promise<GqlOrderPayment> {
    this.assertAcquiringConfigured();

    const { id, data } = await this.loadOwned(orderId, uid);

    if (data.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ConflictException(
        data.status === OrderStatus.CANCELLED
          ? 'This order was cancelled'
          : 'This order is already paid for',
      );
    }

    // The old invoice may still be payable. Withdraw it, so a stale tab
    // cannot take a second payment for the same order.
    if (data.invoiceId) {
      await this.withdrawInvoice(data.invoiceId);
    }

    return this.openInvoice({
      id,
      order: data,
      redirectUrl: this.resolveRedirectUrl(redirectUrl),
      requestOrigin,
    });
  }

  private async openInvoice({
    id,
    order,
    redirectUrl,
    requestOrigin,
  }: {
    id: string;
    order: OrderDoc;
    redirectUrl: string;
    requestOrigin?: string | null;
  }): Promise<GqlOrderPayment> {
    const [first] = order.items;
    const destination = first
      ? `Передзамовлення: ${first.name}`
      : `Замовлення ${id}`;

    let invoice: CreatedInvoice;
    try {
      invoice = await this.monobank.createInvoice({
        amount: order.amount,
        ccy: order.currency,
        // Our own id: monobank echoes it back on every webhook, which is how
        // a callback finds the order it belongs to.
        reference: id,
        destination,
        basketOrder: order.items.map((item) => ({
          name: item.name,
          qty: item.quantity,
          sum: item.sum,
          unit: item.unit,
          code: item.productId,
          ...(item.image ? { icon: item.image } : {}),
        })),
        // Only redirectUrl — successUrl and failUrl have to be enabled by
        // monobank support, so one return address covers both outcomes.
        redirectUrl: `${redirectUrl}${redirectUrl.includes('?') ? '&' : '?'}order=${id}`,
        webHookUrl: this.webhookUrl(requestOrigin),
        validity: INVOICE_VALIDITY_SECONDS,
      });
    } catch (error) {
      // The raw error can carry the merchant token, so it is logged here and
      // never handed back to the caller.
      this.logger.error(`could not open an invoice for order ${id}`, error);
      throw error instanceof MonobankError
        ? new ServiceUnavailableException(
            'monobank did not accept the payment. Try again in a minute.',
          )
        : error;
    }

    const now = Timestamp.now();
    await this.firestore.orders.doc(id).set(
      {
        invoiceId: invoice.invoiceId,
        paymentPageUrl: invoice.pageUrl,
        paymentStatus: PaymentStatus.CREATED,
        // A retry starts a fresh attempt: whatever went wrong last time is
        // no longer the reason this order is unpaid.
        failureReason: null,
        paymentModifiedDate: null,
        updatedAt: now,
      },
      { merge: true },
    );

    const doc = await this.firestore.orders.doc(id).get();
    const gqlOrder = this.toGqlOrder(id, doc.data());
    await this.publish(gqlOrder);

    return {
      order: gqlOrder,
      invoiceId: invoice.invoiceId,
      pageUrl: invoice.pageUrl,
    };
  }

  // ─── Managing ─────────────────────────────────────────────────────────

  /** Corrects where the order should go. Allowed until it ships. */
  async updateOrderDelivery({
    orderId,
    uid,
    input,
  }: {
    orderId: string;
    uid: string;
    input: DeliveryInput;
  }): Promise<GqlOrder> {
    const { id, data } = await this.loadOwned(orderId, uid);

    if (!isEditable(data.status)) {
      throw new ConflictException(notEditableReason(data.status));
    }

    const delivery = toDeliveryDoc(input);
    assertDeliverable(delivery);

    await this.firestore.orders.doc(id).set(
      {
        delivery,
        // Keep the contact phone in step when there was not one yet.
        ...(data.contactPhone ? {} : { contactPhone: delivery.phone }),
        updatedAt: Timestamp.now(),
        events: [
          ...data.events,
          event(data.status, OrderActor.CUSTOMER, 'Оновлено дані доставки'),
        ],
      },
      { merge: true },
    );

    return this.readAndPublish(id);
  }

  /** Corrects the phone/email we reach the customer on. */
  async updateOrderContact({
    orderId,
    uid,
    input,
  }: {
    orderId: string;
    uid: string;
    input: OrderContactInput;
  }): Promise<GqlOrder> {
    const { id, data } = await this.loadOwned(orderId, uid);

    if (!isEditable(data.status)) {
      throw new ConflictException(notEditableReason(data.status));
    }

    const phone = normalizePhone(input.phone);
    if (!isPlausiblePhone(phone)) {
      throw new BadRequestException('That does not look like a phone number');
    }

    await this.firestore.orders.doc(id).set(
      {
        contactPhone: phone,
        contactEmail: input.email ?? null,
        updatedAt: Timestamp.now(),
        events: [
          ...data.events,
          event(data.status, OrderActor.CUSTOMER, 'Оновлено контактні дані'),
        ],
      },
      { merge: true },
    );

    return this.readAndPublish(id);
  }

  /**
   * Calls the order off.
   *
   * An unpaid invoice is withdrawn so it cannot be paid afterwards; money
   * that did arrive is sent back through monobank. A refund monobank answers
   * `processing` for is not lost — the `reversed` webhook finishes the job.
   */
  async cancelOrder({
    orderId,
    uid,
    reason,
  }: {
    orderId: string;
    uid: string;
    reason?: string | null;
  }): Promise<GqlOrder> {
    const { id, data } = await this.loadOwned(orderId, uid);

    if (!isCancellable(data.status)) {
      throw new ConflictException(
        data.status === OrderStatus.CANCELLED ||
          data.status === OrderStatus.REFUNDED
          ? 'This order is already cancelled'
          : 'This order has already shipped — get in touch and we will sort it out',
      );
    }

    const paid =
      data.paymentStatus === PaymentStatus.SUCCESS ||
      data.paymentStatus === PaymentStatus.HOLD;

    let refunded = false;
    let note = 'Замовлення скасовано';

    if (paid && data.invoiceId) {
      let result: CancelledInvoice;
      try {
        result = await this.monobank.cancelInvoice(data.invoiceId);
      } catch (error) {
        this.logger.error(`refund failed for order ${id}`, error);
        throw new ServiceUnavailableException(
          'monobank could not process the refund. Try again, or write to us and we will return the money by hand.',
        );
      }

      if (result.status === 'failure') {
        throw new ConflictException(
          'monobank refused the refund. Write to us and we will return the money by hand.',
        );
      }

      refunded = result.status === 'success';
      note = refunded
        ? 'Замовлення скасовано, кошти повернуто'
        : 'Замовлення скасовано, повернення коштів у процесі';
    } else if (data.invoiceId) {
      await this.withdrawInvoice(data.invoiceId);
    }

    const status = refunded ? OrderStatus.REFUNDED : OrderStatus.CANCELLED;
    const now = Timestamp.now();

    await this.firestore.orders.doc(id).set(
      {
        status,
        cancelReason: reason ?? null,
        // Nothing left to pay: drop the page so no stale link is offered.
        paymentPageUrl: null,
        ...(refunded ? { paymentStatus: PaymentStatus.REVERSED } : {}),
        updatedAt: now,
        events: [...data.events, event(status, OrderActor.CUSTOMER, note)],
      },
      { merge: true },
    );

    return this.readAndPublish(id);
  }

  /**
   * Asks monobank what really happened and applies it.
   *
   * Webhooks get lost, and `expired` never sends one at all, so a customer
   * staring at a stale "waiting for payment" needs a way to settle it.
   */
  async refreshOrderPayment(orderId: string, uid: string): Promise<GqlOrder> {
    const { id, data } = await this.loadOwned(orderId, uid);

    if (!data.invoiceId) {
      return this.toGqlOrder(id, data);
    }

    let status: InvoiceStatusResponse;
    try {
      status = await this.monobank.getInvoiceStatus(data.invoiceId);
    } catch (error) {
      this.logger.error(`could not read invoice ${data.invoiceId}`, error);
      throw new ServiceUnavailableException(
        'monobank is not answering right now. Try again in a minute.',
      );
    }

    const { order } = await this.applyInvoiceStatus(
      { ...status, reference: status.reference ?? id },
      OrderActor.CUSTOMER,
    );

    return order ?? this.toGqlOrder(id, data);
  }

  // ─── Dispatch ─────────────────────────────────────────────────────────
  // The two points where somebody has physically done something to the
  // parcel. Authorised by the `admin` custom claim rather than by ownership
  // — these are not the customer's to call — so unlike everything above,
  // they load the order without an owner check.

  /**
   * Takes the order off the customer's hands to be put together.
   *
   * The one thing this changes is that the address stops being editable: the
   * waybill is filled in by hand from what the order says, and an address
   * that moves between being read and being printed is a parcel going
   * somewhere nobody will look for it. Calling the order off is still
   * allowed — a parcel that has not gone anywhere can be unpacked.
   */
  async markOrderInAssembly({
    orderId,
    byUid,
  }: {
    orderId: string;
    byUid: string;
  }): Promise<GqlOrder> {
    const { id, data } = await this.load(orderId);

    if (data.status === OrderStatus.IN_ASSEMBLY) {
      // Already where it was being asked to go.
      return this.toGqlOrder(id, data);
    }

    if (data.status !== OrderStatus.PAID) {
      throw new ConflictException(
        data.status === OrderStatus.PENDING_PAYMENT
          ? 'This order has not been paid for'
          : `An order that is ${data.status} cannot go into assembly`,
      );
    }

    this.logger.log(`started assembly on order ${id} (by ${byUid})`);

    await this.firestore.orders.doc(id).set(
      {
        status: OrderStatus.IN_ASSEMBLY,
        updatedAt: Timestamp.now(),
        events: [
          ...data.events,
          event(
            OrderStatus.IN_ASSEMBLY,
            OrderActor.ADMIN,
            'Замовлення збирається',
            byUid,
          ),
        ],
      },
      { merge: true },
    );

    return this.readAndPublish(id);
  }

  /**
   * Records the waybill and marks the order shipped.
   *
   * The waybill itself is created by hand in Nova Poshta's own cabinet; what
   * reaches here is its number. That is the whole of the carrier integration
   * for now, and it is enough for the customer: the storefront already asks
   * for `trackingNumber` and already watches `orderUpdates`, so writing it
   * puts the number on a page somebody may be looking at.
   *
   * Accepted again on an order that has already shipped, which is how a
   * mistyped number is corrected — the status does not move a second time,
   * and the timeline says a correction rather than a dispatch.
   */
  async markOrderShipped({
    orderId,
    trackingNumber,
    byUid,
  }: {
    orderId: string;
    trackingNumber: string;
    byUid: string;
  }): Promise<GqlOrder> {
    const { id, data } = await this.load(orderId);

    if (!SHIPPABLE_STATUSES.includes(data.status)) {
      throw new ConflictException(
        data.status === OrderStatus.PENDING_PAYMENT
          ? 'This order has not been paid for'
          : `An order that is ${data.status} cannot be shipped`,
      );
    }

    const tracking = normalizeTrackingNumber(trackingNumber);
    assertTrackingNumber(tracking, data.delivery?.method);

    const correction = data.status === OrderStatus.SHIPPED;
    if (correction && data.trackingNumber === tracking) {
      // Nothing changed. Returning early keeps a double-click out of the
      // timeline rather than writing the same entry twice.
      return this.toGqlOrder(id, data);
    }

    this.logger.log(
      `${correction ? 'corrected the waybill on' : 'shipped'} order ${id} (by ${byUid})`,
    );

    await this.firestore.orders.doc(id).set(
      {
        trackingNumber: tracking,
        status: OrderStatus.SHIPPED,
        updatedAt: Timestamp.now(),
        events: [
          ...data.events,
          event(
            OrderStatus.SHIPPED,
            OrderActor.ADMIN,
            correction
              ? 'Оновлено номер накладної'
              : `Відправлено, ЕН ${tracking}`,
            byUid,
          ),
        ],
      },
      { merge: true },
    );

    return this.readAndPublish(id);
  }

  /**
   * Closes out an order the customer has collected.
   *
   * Only from `SHIPPED`: nothing polls Nova Poshta, so this is somebody
   * noticing, and an order that never went out cannot have arrived.
   */
  async markOrderDelivered({
    orderId,
    byUid,
  }: {
    orderId: string;
    byUid: string;
  }): Promise<GqlOrder> {
    const { id, data } = await this.load(orderId);

    if (data.status === OrderStatus.DELIVERED) {
      // Already where it was being asked to go. Idempotent rather than a
      // conflict, so a retried call is not an error to explain.
      return this.toGqlOrder(id, data);
    }

    if (data.status !== OrderStatus.SHIPPED) {
      throw new ConflictException(
        'Only a shipped order can be marked delivered',
      );
    }

    this.logger.log(`delivered order ${id} (by ${byUid})`);

    await this.firestore.orders.doc(id).set(
      {
        status: OrderStatus.DELIVERED,
        updatedAt: Timestamp.now(),
        events: [
          ...data.events,
          event(
            OrderStatus.DELIVERED,
            OrderActor.ADMIN,
            'Замовлення отримано',
            byUid,
          ),
        ],
      },
      { merge: true },
    );

    return this.readAndPublish(id);
  }

  // ─── Payment callbacks ────────────────────────────────────────────────

  /**
   * Moves an order along from a monobank invoice status, whether it arrived
   * by webhook or because we asked.
   *
   * Idempotent: monobank retries, and redelivering the same status writes
   * nothing new. Ordering is decided by `modifiedDate`, not by arrival —
   * their docs are explicit that a `success` can land before the `processing`
   * that preceded it.
   */
  async applyInvoiceStatus(
    payload: InvoiceStatusResponse,
    actor: OrderActor = OrderActor.MONOBANK,
  ): Promise<AppliedStatus> {
    const ref = await this.findOrderRef(payload);
    if (!ref) {
      this.logger.warn(
        `no order for invoice ${payload.invoiceId} (reference ${payload.reference ?? '—'})`,
      );
      return { order: null, changed: false };
    }

    const paymentStatus = PAYMENT_STATUS_BY_INVOICE[payload.status];
    if (!paymentStatus) {
      this.logger.warn(`unknown invoice status "${payload.status}"`);
      return { order: null, changed: false };
    }

    const changed = await this.firestore.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;

      const data = snap.data();

      // A retry opens a new invoice and withdraws the old one, and monobank
      // may well call back about the old one afterwards. Only the invoice the
      // order is currently waiting on gets to set its payment status.
      if (
        data.invoiceId &&
        payload.invoiceId &&
        data.invoiceId !== payload.invoiceId
      ) {
        this.logger.warn(
          `ignoring "${payload.status}" for superseded invoice ${payload.invoiceId} on order ${ref.id}`,
        );
        return false;
      }

      if (data.paymentStatus === paymentStatus) return false;

      if (!supersedes(payload.modifiedDate, data)) {
        this.logger.warn(
          `ignoring stale "${payload.status}" for invoice ${payload.invoiceId}`,
        );
        return false;
      }

      if (payload.amount !== undefined && payload.amount !== data.amount) {
        // Not fatal — monobank is the one holding the money — but somebody
        // should look at an order that was paid for a different sum.
        this.logger.warn(
          `order ${ref.id} is ${data.amount} but monobank reports ${payload.amount}`,
        );
      }

      const now = Timestamp.now();
      const status = nextOrderStatus(data.status, paymentStatus);
      const update: Partial<OrderDoc> = {
        paymentStatus,
        status,
        paymentModifiedDate: payload.modifiedDate ?? null,
        failureReason: payload.failureReason ?? null,
        updatedAt: now,
      };

      if (paymentStatus === PaymentStatus.SUCCESS && !data.paidAt) {
        update.paidAt = now;
      }

      // A dead invoice must not leave a payable-looking link behind.
      if (
        paymentStatus === PaymentStatus.EXPIRED ||
        paymentStatus === PaymentStatus.FAILURE
      ) {
        update.paymentPageUrl = null;
      }

      if (status !== data.status) {
        update.events = [
          ...data.events,
          event(status, actor, noteFor(paymentStatus, payload.failureReason)),
        ];
      }

      tx.set(ref, update, { merge: true });
      return true;
    });

    const doc = await ref.get();
    if (!doc.exists) return { order: null, changed: false };

    const order = this.toGqlOrder(doc.id, doc.data());
    if (changed) {
      await this.publish(order);

      if (order.status === OrderStatus.PAID) {
        // TODO(fulfilment): confirmation email and the assembly queue entry
        // belong here. Guarded by `changed`, so a redelivered webhook cannot
        // send a second confirmation.
        this.logger.log(
          `order ${doc.id} paid: ${order.amount} (${order.currency})`,
        );
      }
    }

    return { order, changed };
  }

  /**
   * Catches up on invoices whose webhook never arrived — and on `expired`,
   * which never sends one.
   *
   * Deliberately small and slow: this is a safety net, not the mechanism.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async reconcilePendingPayments(): Promise<number> {
    if (process.env.ORDERS_RECONCILE_CRON === 'false') return 0;
    if (!this.monobank.configured) return 0;

    // Anything younger than the invoice window is still legitimately open.
    const cutoff = new Date(Date.now() - INVOICE_VALIDITY_SECONDS * 1000);

    const stale = await this.firestore.orders
      .where('status', '==', OrderStatus.PENDING_PAYMENT)
      .where('updatedAt', '<', Timestamp.fromDate(cutoff))
      .orderBy('updatedAt', 'asc')
      .limit(25)
      .get();

    let reconciled = 0;

    for (const doc of stale.docs) {
      const { invoiceId } = doc.data();
      if (!invoiceId) continue;

      try {
        const status = await this.monobank.getInvoiceStatus(invoiceId);
        const { changed } = await this.applyInvoiceStatus(
          { ...status, reference: status.reference ?? doc.id },
          OrderActor.SYSTEM,
        );
        if (changed) reconciled += 1;
      } catch (error) {
        this.logger.warn(`could not reconcile order ${doc.id}`, error);
      }
    }

    if (reconciled > 0) {
      this.logger.log(`reconciled ${reconciled} pending order(s)`);
    }

    return reconciled;
  }

  // ─── Plumbing ─────────────────────────────────────────────────────────

  private assertAcquiringConfigured() {
    if (!this.monobank.configured) {
      throw new ServiceUnavailableException(
        'Payments are not configured on this deployment',
      );
    }
  }

  private priceItems(lines: PlaceOrderInput['items']): OrderItemDoc[] {
    if (!lines?.length) {
      throw new BadRequestException('An order needs at least one item');
    }

    const merged = new Map<string, number>();
    for (const line of lines) {
      const quantity = Number(line.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new BadRequestException(
          'Quantities are whole numbers, 1 or more',
        );
      }
      merged.set(line.productId, (merged.get(line.productId) ?? 0) + quantity);
    }

    return [...merged].map(([productId, quantity]) => {
      const product = getProduct(productId);
      if (!product) {
        throw new BadRequestException(`No such product: ${productId}`);
      }
      if (quantity > product.maxQuantity) {
        throw new BadRequestException(
          `Up to ${product.maxQuantity} × ${product.name} per order — these are built by hand`,
        );
      }

      return {
        productId: product.id,
        name: product.name,
        unitPrice: product.price,
        quantity,
        sum: product.price * quantity,
        unit: product.unit,
        image: product.image ?? null,
      };
    });
  }

  /**
   * Where monobank sends the buyer back to.
   *
   * Allow-listed: the URL is handed to a third party that redirects a paying
   * customer to it, so an unchecked one turns our checkout into an open
   * redirect with a bank's page as the referrer.
   */
  private resolveRedirectUrl(requested?: string | null): string {
    const storefront = (
      process.env.STOREFRONT_URL ?? 'https://tsutsyk.live'
    ).replace(/\/+$/, '');

    if (!requested) return storefront;

    const allowed = [
      storefront,
      ...(process.env.ORDER_REDIRECT_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    ];

    let url: URL;
    try {
      url = new URL(requested);
    } catch {
      throw new BadRequestException('redirectUrl must be an absolute URL');
    }

    if (!allowed.some((origin) => url.origin === new URL(origin).origin)) {
      throw new BadRequestException('redirectUrl is not on an allowed origin');
    }

    return url.toString().replace(/\/+$/, '');
  }

  /** Where monobank posts status changes. */
  private webhookUrl(requestOrigin?: string | null): string | undefined {
    const base = (process.env.API_PUBLIC_URL ?? requestOrigin ?? '').replace(
      /\/+$/,
      '',
    );

    if (!base) {
      // Without a callback we would only ever learn of a payment by polling.
      this.logger.warn(
        'API_PUBLIC_URL is not set and the request carried no origin — the invoice has no webhook',
      );
      return undefined;
    }

    return `${base}/payments/monobank/webhook`;
  }

  /** Writes the order under an id nobody is using. */
  private async createWithFreshId(order: OrderDoc): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newOrderId();
      const ref = this.firestore.orders.doc(id);

      const created = await this.firestore.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) return false;
        tx.create(ref, order);
        return true;
      });

      if (created) return id;
    }

    throw new ConflictException('Could not allocate an order number');
  }

  private async withdrawInvoice(invoiceId: string) {
    try {
      await this.monobank.removeInvoice(invoiceId);
    } catch (error) {
      // Best effort: monobank refuses to remove an invoice that is already
      // paid or already gone, and neither is a reason to fail the caller.
      this.logger.warn(`could not withdraw invoice ${invoiceId}`, error);
    }
  }

  /**
   * Any order, by number.
   *
   * No owner check, so it is only ever reached from behind `AdminGuard` —
   * `loadOwned` below is what every customer-facing path uses, and the two
   * are kept apart so that dropping the uid is a decision rather than an
   * argument somebody forgot to pass.
   */
  private async load(orderId: string): Promise<{ id: string; data: OrderDoc }> {
    const id = normalizeOrderId(orderId);
    const doc = await this.firestore.orders.doc(id).get();

    if (!doc.exists) throw new NotFoundException('No such order');

    return { id, data: doc.data() };
  }

  private async loadOwned(
    orderId: string,
    uid: string,
  ): Promise<{ id: string; data: OrderDoc }> {
    const id = normalizeOrderId(orderId);
    const doc = await this.firestore.orders.doc(id).get();

    if (!doc.exists) throw new NotFoundException('No such order');

    const data = doc.data();
    if (data.ownerUid !== uid) {
      throw new ForbiddenException('This order belongs to someone else');
    }

    return { id, data };
  }

  private async findOrderRef(payload: InvoiceStatusResponse) {
    if (payload.reference) {
      const ref = this.firestore.orders.doc(
        normalizeOrderId(payload.reference),
      );
      const snap = await ref.get();
      if (snap.exists) return ref;
    }

    if (!payload.invoiceId) return null;

    // A reference we do not recognise still has an invoice id, and that is
    // stored on the order the moment it is opened.
    const byInvoice = await this.firestore.orders
      .where('invoiceId', '==', payload.invoiceId)
      .limit(1)
      .get();

    return byInvoice.empty ? null : byInvoice.docs[0].ref;
  }

  private async readAndPublish(id: string): Promise<GqlOrder> {
    const doc = await this.firestore.orders.doc(id).get();
    const order = this.toGqlOrder(doc.id, doc.data());
    await this.publish(order);
    return order;
  }

  /**
   * Announces a change to whoever is watching this order.
   *
   * Only the tracking view goes out: the socket carries no bearer token, so
   * the subscription is guarded by knowing the order number, and that is not
   * enough to be shown a customer's phone number.
   */
  private async publish(order: GqlOrder) {
    const tracking: GqlOrderTracking = {
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      trackingNumber: order.trackingNumber,
      updatedAt: order.updatedAt,
    };
    await this.pubSub.publish(ORDER_UPDATES, { [ORDER_UPDATES]: tracking });
  }

  toGqlOrder(id: string, data: OrderDoc): GqlOrder {
    return {
      id,
      status: data.status,
      paymentStatus: data.paymentStatus ?? null,
      items: data.items.map((item) => ({ ...item, image: item.image ?? null })),
      amount: data.amount,
      currency: data.currency ?? UAH,
      contactPhone: data.contactPhone ?? null,
      contactEmail: data.contactEmail ?? null,
      delivery: data.delivery ?? null,
      trackingNumber: data.trackingNumber ?? null,
      invoiceId: data.invoiceId ?? null,
      paymentPageUrl: data.paymentPageUrl ?? null,
      failureReason: data.failureReason ?? null,
      cancelReason: data.cancelReason ?? null,
      tsutsykIds: data.tsutsykIds ?? [],
      events: (data.events ?? []).map((entry) => ({
        at: toIso(entry.at),
        status: entry.status,
        actor: entry.actor,
        note: entry.note ?? null,
      })),
      editable: isEditable(data.status),
      cancellable: isCancellable(data.status),
      payable: data.status === OrderStatus.PENDING_PAYMENT,
      createdAt: toIso(data.createdAt),
      updatedAt: toIso(data.updatedAt ?? data.createdAt),
      paidAt: data.paidAt ? toIso(data.paidAt) : null,
    };
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────

export function newOrderId(): string {
  // 256 / 32 is exact, so no character is more likely than another.
  return [...randomBytes(ID_LENGTH)]
    .map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length])
    .join('');
}

export function normalizeOrderId(id: string): string {
  return String(id ?? '')
    .trim()
    .toUpperCase();
}

/** Digits only, so `+380 (67) 123-45-67` and `0671234567` are one number. */
export function normalizePhone(phone: string): string {
  return String(phone ?? '').replace(/\D/g, '');
}

export function isPlausiblePhone(phone: string): boolean {
  const digits = normalizePhone(phone);
  return digits.length >= 9 && digits.length <= 15;
}

/**
 * Whether two phone numbers are the same number.
 *
 * Compared on the last nine digits: the same Ukrainian line is written
 * `+380671234567`, `380671234567` and `0671234567`, and a customer typing it
 * from memory should not be locked out of their own order over a prefix.
 */
export function samePhone(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  if (left.length < 9 || right.length < 9) return left === right;
  return left.slice(-9) === right.slice(-9);
}

export function isEditable(status: OrderStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

/**
 * A waybill number as it was read off the printed sheet.
 *
 * Nova Poshta prints its numbers in groups — `2045 0912 3456 78` — and the
 * cabinet copies them with the spaces in. Stripping the separators here means
 * the customer is shown one consistent number whichever way it was pasted,
 * and that a re-entered number compares equal to the stored one.
 */
export function normalizeTrackingNumber(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/[\s-]/g, '');
}

/** Enough of a number that a customer following it reaches their parcel. */
export function assertTrackingNumber(
  tracking: string,
  method?: DeliveryMethod | null,
) {
  if (!tracking) {
    throw new BadRequestException('A waybill number is needed');
  }
  if (tracking.length > MAX_TRACKING_NUMBER_LENGTH) {
    throw new BadRequestException('That is not a waybill number');
  }

  const novaPoshta =
    method === DeliveryMethod.NOVA_POSHTA_BRANCH ||
    method === DeliveryMethod.NOVA_POSHTA_COURIER;

  if (novaPoshta && !NOVA_POSHTA_TTN.test(tracking)) {
    throw new BadRequestException(
      'A Nova Poshta waybill number is fourteen digits',
    );
  }
}

export function isCancellable(status: OrderStatus): boolean {
  return CANCELLABLE_STATUSES.includes(status);
}

/**
 * Why the delivery details are locked, in words that are actually true.
 *
 * Worth branching on: an order frozen because somebody is filling in its
 * waybill has not shipped yet, and telling its customer it has would send
 * them chasing a parcel that is still on the table.
 */
export function notEditableReason(status: OrderStatus): string {
  switch (status) {
    case OrderStatus.IN_ASSEMBLY:
      return 'This order is already being put together — get in touch and we will sort it out';
    case OrderStatus.CANCELLED:
    case OrderStatus.REFUNDED:
      return 'This order has been cancelled';
    default:
      return 'This order has already shipped — get in touch and we will sort it out';
  }
}

/**
 * The order status a payment status implies.
 *
 * Only moves an order that is still waiting for money: once it is being
 * assembled or has shipped, a late webhook must not drag it backwards.
 */
export function nextOrderStatus(
  current: OrderStatus,
  payment: PaymentStatus,
): OrderStatus {
  if (payment === PaymentStatus.REVERSED) return OrderStatus.REFUNDED;

  if (current !== OrderStatus.PENDING_PAYMENT) return current;

  // `hold` is money set aside but not taken. We never capture separately, so
  // it is not yet a paid order.
  return payment === PaymentStatus.SUCCESS ? OrderStatus.PAID : current;
}

/**
 * Whether an incoming status describes a later state than the stored one.
 *
 * monobank does not guarantee webhook ordering and says the payload with the
 * greater `modifiedDate` is the current one, so that field decides. With a
 * timestamp missing on either side there is nothing to compare, and we fall
 * back to refusing to walk a settled payment back to an in-flight one.
 */
export function supersedes(
  incoming: string | null | undefined,
  stored: Pick<OrderDoc, 'paymentStatus' | 'paymentModifiedDate'>,
): boolean {
  if (incoming && stored.paymentModifiedDate) {
    return incoming > stored.paymentModifiedDate;
  }
  return !(
    stored.paymentStatus &&
    FINAL_PAYMENT_STATUSES.includes(stored.paymentStatus)
  );
}

function toIso(value: Timestamp | null | undefined): string | null {
  return value ? value.toDate().toISOString() : null;
}

function event(
  status: OrderStatus,
  actor: OrderActor,
  note: string | null,
  byUid?: string,
): OrderEventDoc {
  // `byUid` is left off entirely rather than written as null when there is
  // none: Firestore stores what it is given, and an absent field reads back
  // the same as a null one without occupying a byte on every customer event.
  return {
    at: Timestamp.now(),
    status,
    actor,
    note,
    ...(byUid ? { byUid } : {}),
  };
}

function noteFor(
  payment: PaymentStatus,
  failureReason?: string | null,
): string | null {
  switch (payment) {
    case PaymentStatus.SUCCESS:
      return 'Оплату отримано';
    case PaymentStatus.FAILURE:
      return failureReason
        ? `Оплата не пройшла: ${failureReason}`
        : 'Оплата не пройшла';
    case PaymentStatus.EXPIRED:
      return 'Термін дії рахунку минув';
    case PaymentStatus.REVERSED:
      return 'Кошти повернуто';
    default:
      return null;
  }
}

function toDeliveryDoc(input: DeliveryInput): OrderDeliveryDoc {
  return {
    method: input.method,
    recipientName: input.recipientName.trim(),
    phone: normalizePhone(input.phone),
    city: input.city?.trim() || null,
    branch: input.branch?.trim() || null,
    address: input.address?.trim() || null,
    comment: input.comment?.trim() || null,
  };
}

/** Enough of an address that a parcel can actually be handed over. */
function assertDeliverable(delivery: OrderDeliveryDoc) {
  if (!delivery.recipientName) {
    throw new BadRequestException('A recipient name is needed');
  }
  if (!isPlausiblePhone(delivery.phone)) {
    throw new BadRequestException('That does not look like a phone number');
  }

  switch (delivery.method) {
    case DeliveryMethod.PICKUP:
      return;
    case DeliveryMethod.NOVA_POSHTA_COURIER:
      if (!delivery.city || !delivery.address) {
        throw new BadRequestException(
          'Courier delivery needs a city and a street address',
        );
      }
      return;
    default:
      if (!delivery.city || !delivery.branch) {
        throw new BadRequestException(
          'Branch delivery needs a city and a branch number',
        );
      }
  }
}
