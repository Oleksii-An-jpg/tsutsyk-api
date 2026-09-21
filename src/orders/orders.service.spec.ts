import { Timestamp } from 'firebase-admin/firestore';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  OrdersService,
  newOrderId,
  nextOrderStatus,
  samePhone,
  supersedes,
} from './orders.service';
import { MonobankService } from './monobank.service';
import { FirestoreService } from '../firestore/firestore.service';
import { OrderDoc } from '../firestore/firestore.types';
import {
  DeliveryMethod,
  OrderActor,
  OrderStatus,
  OrderTracking,
  PaymentStatus,
  PlaceOrderInput,
} from '../graphql.schema';

// ─── A Firestore small enough to reason about ───────────────────────────
// Only what OrdersService actually uses: documents, merging writes, the two
// queries it runs, and transactions that see the same map.

/**
 * Deep-copies the way Firestore's own round-trip does: plain data is copied,
 * Timestamps survive as Timestamps. `structuredClone` would flatten them into
 * bare objects and every date would read back broken.
 */
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (value instanceof Timestamp) return value;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        clone(entry),
      ]),
    ) as T;
  }
  return value;
}

interface FakeSnapshot {
  id: string;
  exists: boolean;
  ref: FakeRef;
  data: () => OrderDoc;
}

class FakeRef {
  constructor(
    private readonly store: Map<string, OrderDoc>,
    readonly id: string,
  ) {}

  get(): Promise<FakeSnapshot> {
    const data = this.store.get(this.id);
    return Promise.resolve({
      id: this.id,
      exists: data !== undefined,
      ref: this,
      data: () => clone(data),
    });
  }

  set(value: Partial<OrderDoc>, options?: { merge?: boolean }) {
    const previous = options?.merge ? (this.store.get(this.id) ?? {}) : {};
    this.store.set(this.id, {
      ...(previous as OrderDoc),
      ...(clone(value) as OrderDoc),
    });
    return Promise.resolve();
  }
}

/** Timestamps compare by their instant; everything else by `<`. */
function compare(a: unknown, b: unknown): number {
  if (a instanceof Timestamp && b instanceof Timestamp) {
    return a.toMillis() - b.toMillis();
  }
  if (a === b) return 0;
  return (a as number) < (b as number) ? -1 : 1;
}

class FakeQuery {
  constructor(
    private readonly store: Map<string, OrderDoc>,
    private readonly filters: [keyof OrderDoc, string, unknown][] = [],
    private readonly max?: number,
    private readonly order?: [keyof OrderDoc, 'asc' | 'desc'],
  ) {}

  where(field: keyof OrderDoc, op: string, value: unknown) {
    return new FakeQuery(
      this.store,
      [...this.filters, [field, op, value]],
      this.max,
      this.order,
    );
  }

  // Ordering is real rather than a no-op: `listOrders` promises newest
  // first, and a fake that ignored it would let that promise rot.
  orderBy(field: keyof OrderDoc, direction: 'asc' | 'desc' = 'asc') {
    return new FakeQuery(this.store, this.filters, this.max, [
      field,
      direction,
    ]);
  }

  limit(max: number) {
    return new FakeQuery(this.store, this.filters, max, this.order);
  }

  get() {
    const docs = [...this.store.entries()]
      .filter(([, doc]) =>
        this.filters.every(([field, op, value]) => {
          const actual = doc[field];
          if (op === '==') return actual === value;
          if (op === '<') return (actual as Timestamp) < (value as Timestamp);
          return true;
        }),
      )
      .sort(([, left], [, right]) => {
        if (!this.order) return 0;
        const [field, direction] = this.order;
        const sign = direction === 'desc' ? -1 : 1;
        return sign * compare(left[field], right[field]);
      })
      // Firestore applies the limit after ordering, so this must too —
      // otherwise "the newest 3" would be "any 3, newest first".
      .slice(0, this.max ?? Infinity)
      .map(([id, doc]) => ({
        id,
        exists: true,
        ref: new FakeRef(this.store, id),
        data: () => clone(doc),
      }));

    return Promise.resolve({
      docs,
      empty: docs.length === 0,
      size: docs.length,
    });
  }
}

function fakeFirestore() {
  const store = new Map<string, OrderDoc>();

  const orders = {
    doc: (id: string) => new FakeRef(store, id),
    where: (field: keyof OrderDoc, op: string, value: unknown) =>
      new FakeQuery(store).where(field, op, value),
    orderBy: (field: keyof OrderDoc, direction: 'asc' | 'desc' = 'asc') =>
      new FakeQuery(store).orderBy(field, direction),
    limit: (max: number) => new FakeQuery(store).limit(max),
  };

  const db = {
    runTransaction: <T>(
      body: (tx: {
        get: (ref: FakeRef) => Promise<FakeSnapshot>;
        set: (
          ref: FakeRef,
          value: Partial<OrderDoc>,
          options?: { merge?: boolean },
        ) => void;
        create: (ref: FakeRef, value: OrderDoc) => void;
      }) => Promise<T>,
    ) =>
      body({
        get: (ref) => ref.get(),
        set: (ref, value, options) => void ref.set(value, options),
        create: (ref, value) => void ref.set(value),
      }),
  };

  return { store, service: { orders, db } as unknown as FirestoreService };
}

interface FakeMonobank {
  configured: boolean;
  createInvoice: jest.Mock;
  getInvoiceStatus: jest.Mock;
  removeInvoice: jest.Mock;
  cancelInvoice: jest.Mock;
  verifyWebhookSignature: jest.Mock;
}

function fakeMonobank(overrides: Partial<FakeMonobank> = {}): FakeMonobank {
  return {
    configured: true,
    createInvoice: jest.fn().mockResolvedValue({
      invoiceId: 'inv_1',
      pageUrl: 'https://pay.mbnk.biz/inv_1',
    }),
    getInvoiceStatus: jest.fn(),
    removeInvoice: jest.fn().mockResolvedValue({}),
    cancelInvoice: jest.fn().mockResolvedValue({ status: 'success' }),
    verifyWebhookSignature: jest.fn(),
    ...overrides,
  };
}

function setup(monobank: FakeMonobank = fakeMonobank()) {
  const { store, service } = fakeFirestore();
  return {
    store,
    monobank,
    orders: new OrdersService(service, monobank as unknown as MonobankService),
  };
}

const DELIVERY = {
  method: DeliveryMethod.NOVA_POSHTA_BRANCH,
  recipientName: 'Олекса Цуцик',
  phone: '+380671234567',
  city: 'Львів',
  branch: '12',
};

const ONE_TRACKER: PlaceOrderInput = {
  items: [{ productId: 'tsutsyk-tracker', quantity: 1 }],
  delivery: DELIVERY,
};

describe('order helpers', () => {
  it('mints ids without characters that are misread aloud', () => {
    for (let i = 0; i < 200; i++) {
      expect(newOrderId()).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    }
  });

  it('treats the same phone written three ways as one number', () => {
    expect(samePhone('+380671234567', '0671234567')).toBe(true);
    expect(samePhone('380671234567', '+38 (067) 123-45-67')).toBe(true);
    expect(samePhone('+380671234567', '+380671234568')).toBe(false);
    expect(samePhone(null, '0671234567')).toBe(false);
  });

  describe('supersedes', () => {
    it('lets the later modifiedDate win, whatever the arrival order', () => {
      const stored = {
        paymentStatus: PaymentStatus.SUCCESS,
        paymentModifiedDate: '2026-09-16T10:00:00Z',
      };
      expect(supersedes('2026-09-16T10:00:05Z', stored)).toBe(true);
      expect(supersedes('2026-09-16T09:59:00Z', stored)).toBe(false);
    });

    it('refuses to walk a settled payment back when a timestamp is missing', () => {
      expect(
        supersedes(undefined, {
          paymentStatus: PaymentStatus.SUCCESS,
          paymentModifiedDate: null,
        }),
      ).toBe(false);

      expect(
        supersedes(undefined, {
          paymentStatus: PaymentStatus.PROCESSING,
          paymentModifiedDate: null,
        }),
      ).toBe(true);
    });
  });

  describe('nextOrderStatus', () => {
    it('pays an order that was waiting for money', () => {
      expect(
        nextOrderStatus(OrderStatus.PENDING_PAYMENT, PaymentStatus.SUCCESS),
      ).toBe(OrderStatus.PAID);
    });

    it('does not drag a shipped order backwards on a late webhook', () => {
      expect(nextOrderStatus(OrderStatus.SHIPPED, PaymentStatus.SUCCESS)).toBe(
        OrderStatus.SHIPPED,
      );
    });

    it('leaves a failed or expired invoice payable', () => {
      expect(
        nextOrderStatus(OrderStatus.PENDING_PAYMENT, PaymentStatus.EXPIRED),
      ).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it('refunds whatever the order was doing when the money went back', () => {
      expect(
        nextOrderStatus(OrderStatus.IN_ASSEMBLY, PaymentStatus.REVERSED),
      ).toBe(OrderStatus.REFUNDED);
    });
  });
});

describe('placeOrder', () => {
  it('prices the basket from the catalogue, not from the caller', async () => {
    const { orders, monobank, store } = setup();

    const { order, pageUrl } = await orders.placeOrder({
      input: {
        ...ONE_TRACKER,
        items: [{ productId: 'tsutsyk-tracker', quantity: 2 }],
      },
      uid: 'uid-1',
    });

    expect(order.amount).toBe(980_000);
    expect(order.items[0].unitPrice).toBe(490_000);
    expect(pageUrl).toBe('https://pay.mbnk.biz/inv_1');

    // The order exists before the invoice does, and the invoice carries our
    // id so a webhook can find it.
    expect(store.get(order.id)).toBeDefined();
    expect(monobank.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 980_000, reference: order.id }),
    );
  });

  it('adds up repeated lines for the same product before checking the cap', async () => {
    const { orders } = setup();

    await expect(
      orders.placeOrder({
        input: {
          ...ONE_TRACKER,
          items: [
            { productId: 'tsutsyk-tracker', quantity: 2 },
            { productId: 'tsutsyk-tracker', quantity: 2 },
          ],
        },
        uid: 'uid-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a product nobody sells', async () => {
    const { orders } = setup();
    await expect(
      orders.placeOrder({
        input: {
          ...ONE_TRACKER,
          items: [{ productId: 'free-tracker', quantity: 1 }],
        },
        uid: 'uid-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('attaches every order to the caller who placed it', async () => {
    const { orders, store } = setup();
    const { order } = await orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });
    expect(store.get(order.id)?.ownerUid).toBe('uid-1');
  });

  it('refuses an order with nowhere to send it', async () => {
    const { orders } = setup();

    await expect(
      orders.placeOrder({
        input: {
          items: [{ productId: 'tsutsyk-tracker', quantity: 1 }],
        } as PlaceOrderInput,
        uid: 'uid-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reaches for the account when no contact is given', async () => {
    const { orders, store } = setup();

    const { order } = await orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
      account: { email: 'hazda@example.com', phone: '+380509999999' },
    });

    const stored = store.get(order.id);
    expect(stored?.contactEmail).toBe('hazda@example.com');
    // The delivery phone may be the recipient's; the account's own is the one
    // we can be sure reaches the buyer.
    expect(stored?.contactPhone).toBe('380509999999');
  });

  it('refuses delivery details a parcel could not be sent with', async () => {
    const { orders } = setup();

    await expect(
      orders.placeOrder({
        input: {
          ...ONE_TRACKER,
          delivery: {
            method: DeliveryMethod.NOVA_POSHTA_COURIER,
            recipientName: 'Олекса',
            phone: '+380671234567',
            city: 'Львів',
          },
        },
        uid: 'uid-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to send a paying customer off to a foreign origin', async () => {
    const { orders } = setup();
    await expect(
      orders.placeOrder({
        input: { ...ONE_TRACKER, redirectUrl: 'https://evil.example/thanks' },
        uid: 'uid-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('opens the payment page with the order number in the return URL', async () => {
    const { orders, monobank } = setup();
    const { order } = await orders.placeOrder({
      input: { ...ONE_TRACKER, redirectUrl: 'https://tsutsyk.live/' },
      uid: 'uid-1',
    });

    expect(monobank.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUrl: `https://tsutsyk.live?order=${order.id}`,
      }),
    );
  });
});

describe('applyInvoiceStatus', () => {
  async function paidOrder() {
    const context = setup();
    const { order } = await context.orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });
    return { ...context, id: order.id };
  }

  it('marks the order paid once, however often monobank retries', async () => {
    const { orders, id } = await paidOrder();

    const payload = {
      invoiceId: 'inv_1',
      status: 'success' as const,
      amount: 490_000,
      ccy: 980,
      reference: id,
      modifiedDate: '2026-09-16T10:00:00Z',
    };

    const first = await orders.applyInvoiceStatus(payload);
    expect(first.changed).toBe(true);
    expect(first.order?.status).toBe(OrderStatus.PAID);
    expect(first.order?.paidAt).not.toBeNull();

    const redelivery = await orders.applyInvoiceStatus(payload);
    expect(redelivery.changed).toBe(false);
    expect(redelivery.order?.status).toBe(OrderStatus.PAID);
  });

  it('ignores a processing webhook that arrives after the success', async () => {
    const { orders, id } = await paidOrder();

    await orders.applyInvoiceStatus({
      invoiceId: 'inv_1',
      status: 'success',
      amount: 490_000,
      ccy: 980,
      reference: id,
      modifiedDate: '2026-09-16T10:00:05Z',
    });

    const late = await orders.applyInvoiceStatus({
      invoiceId: 'inv_1',
      status: 'processing',
      amount: 490_000,
      ccy: 980,
      reference: id,
      modifiedDate: '2026-09-16T10:00:00Z',
    });

    expect(late.changed).toBe(false);
    expect(late.order?.status).toBe(OrderStatus.PAID);
  });

  it('leaves an expired invoice payable, without a dead payment link', async () => {
    const { orders, id } = await paidOrder();

    const { order } = await orders.applyInvoiceStatus({
      invoiceId: 'inv_1',
      status: 'expired',
      amount: 490_000,
      ccy: 980,
      reference: id,
    });

    expect(order?.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order?.paymentPageUrl).toBeNull();
    expect(order?.payable).toBe(true);
  });

  it('finds the order by invoice id when the reference is not ours', async () => {
    const { orders, id } = await paidOrder();

    const { order } = await orders.applyInvoiceStatus({
      invoiceId: 'inv_1',
      status: 'success',
      amount: 490_000,
      ccy: 980,
      reference: 'something-else',
      modifiedDate: '2026-09-16T10:00:00Z',
    });

    expect(order?.id).toBe(id);
    expect(order?.status).toBe(OrderStatus.PAID);
  });

  it('ignores a callback about an invoice the order has moved on from', async () => {
    const { orders, monobank, id } = await paidOrder();

    monobank.createInvoice.mockResolvedValue({
      invoiceId: 'inv_2',
      pageUrl: 'https://pay.mbnk.biz/inv_2',
    });
    await orders.retryOrderPayment({ orderId: id, uid: 'uid-1' });

    // The withdrawn first invoice calls back late.
    const late = await orders.applyInvoiceStatus({
      invoiceId: 'inv_1',
      status: 'failure',
      amount: 490_000,
      ccy: 980,
      reference: id,
      modifiedDate: '2026-09-16T10:00:00Z',
    });

    expect(late.changed).toBe(false);
    expect(late.order?.paymentPageUrl).toBe('https://pay.mbnk.biz/inv_2');
  });

  it('shrugs at a webhook for an order we have never heard of', async () => {
    const { orders } = setup();
    const result = await orders.applyInvoiceStatus({
      invoiceId: 'inv_unknown',
      status: 'success',
      amount: 1,
      ccy: 980,
    });
    expect(result).toEqual({ order: null, changed: false });
  });
});

describe('managing an order', () => {
  async function placed(monobank: FakeMonobank = fakeMonobank()) {
    const context = setup(monobank);
    const { order } = await context.orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });
    return { ...context, id: order.id };
  }

  type Placed = Awaited<ReturnType<typeof placed>>;

  async function markPaid(context: Placed) {
    await context.orders.applyInvoiceStatus({
      invoiceId: 'inv_1',
      status: 'success',
      amount: 490_000,
      ccy: 980,
      reference: context.id,
      modifiedDate: '2026-09-16T10:00:00Z',
    });
  }

  it('records delivery details the customer fills in after paying', async () => {
    const context = await placed();
    await markPaid(context);

    const order = await context.orders.updateOrderDelivery({
      orderId: context.id,
      uid: 'uid-1',
      input: {
        method: DeliveryMethod.NOVA_POSHTA_BRANCH,
        recipientName: 'Олекса Цуцик',
        phone: '+380671234567',
        city: 'Львів',
        branch: '12',
      },
    });

    expect(order.delivery?.city).toBe('Львів');
    expect(order.delivery?.phone).toBe('380671234567');
  });

  it('will not accept a branch delivery with nowhere to deliver it', async () => {
    const context = await placed();

    await expect(
      context.orders.updateOrderDelivery({
        orderId: context.id,
        uid: 'uid-1',
        input: {
          method: DeliveryMethod.NOVA_POSHTA_BRANCH,
          recipientName: 'Олекса',
          phone: '+380671234567',
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps one customer out of another customer‘s order', async () => {
    const context = await placed();

    await expect(
      context.orders.cancelOrder({ orderId: context.id, uid: 'uid-2' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('withdraws the invoice when an unpaid order is cancelled', async () => {
    const context = await placed();

    const order = await context.orders.cancelOrder({
      orderId: context.id,
      uid: 'uid-1',
      reason: 'передумав',
    });

    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.paymentPageUrl).toBeNull();
    expect(context.monobank.removeInvoice).toHaveBeenCalledWith('inv_1');
  });

  it('refunds a paid order through monobank', async () => {
    const context = await placed();
    await markPaid(context);

    const order = await context.orders.cancelOrder({
      orderId: context.id,
      uid: 'uid-1',
    });

    expect(context.monobank.cancelInvoice).toHaveBeenCalledWith('inv_1');
    expect(order.status).toBe(OrderStatus.REFUNDED);
  });

  it('leaves the order alone when monobank refuses the refund', async () => {
    const context = await placed(
      fakeMonobank({
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'failure' }),
      }),
    );
    await markPaid(context);

    await expect(
      context.orders.cancelOrder({ orderId: context.id, uid: 'uid-1' }),
    ).rejects.toBeInstanceOf(ConflictException);

    const unchanged = await context.orders.getOrder(context.id, 'uid-1');
    expect(unchanged?.status).toBe(OrderStatus.PAID);
  });

  it('refuses to cancel something already on its way', async () => {
    const context = await placed();
    await markPaid(context);
    context.store.set(context.id, {
      ...context.store.get(context.id),
      status: OrderStatus.SHIPPED,
    } as OrderDoc);

    await expect(
      context.orders.cancelOrder({ orderId: context.id, uid: 'uid-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('opens a fresh invoice for an order that was never paid', async () => {
    const context = await placed();

    context.monobank.createInvoice.mockResolvedValue({
      invoiceId: 'inv_2',
      pageUrl: 'https://pay.mbnk.biz/inv_2',
    });

    const { invoiceId } = await context.orders.retryOrderPayment({
      orderId: context.id,
      uid: 'uid-1',
    });

    expect(context.monobank.removeInvoice).toHaveBeenCalledWith('inv_1');
    expect(invoiceId).toBe('inv_2');
  });

  it('will not open a second invoice for something already paid', async () => {
    const context = await placed();
    await markPaid(context);

    await expect(
      context.orders.retryOrderPayment({ orderId: context.id, uid: 'uid-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('dispatching an order', () => {
  // A real Nova Poshta waybill number: fourteen digits.
  const TTN = '20450912345678';

  async function paid(overrides: Partial<OrderDoc> = {}) {
    const context = setup();
    const { order } = await context.orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });

    context.store.set(order.id, {
      ...context.store.get(order.id),
      status: OrderStatus.PAID,
      paymentStatus: PaymentStatus.SUCCESS,
      ...overrides,
    } as OrderDoc);

    return { ...context, id: order.id };
  }

  it('puts the waybill on the order and sends it on its way', async () => {
    const context = await paid();

    const order = await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: TTN,
      byUid: 'admin-1',
    });

    expect(order.status).toBe(OrderStatus.SHIPPED);
    expect(order.trackingNumber).toBe(TTN);
    // A parcel already handed over is no longer the customer's to redirect
    // or call off — the guards that said so were unreachable until now.
    expect(order.editable).toBe(false);
    expect(order.cancellable).toBe(false);

    const last = order.events[order.events.length - 1];
    expect(last.actor).toBe(OrderActor.ADMIN);
    expect(last.status).toBe(OrderStatus.SHIPPED);
  });

  it('tells whoever is watching the order', async () => {
    const context = await paid();
    const publish = jest.spyOn(context.orders.getPubSub(), 'publish');

    await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: TTN,
      byUid: 'admin-1',
    });

    const [channel, payload] = publish.mock.calls[
      publish.mock.calls.length - 1
    ] as [string, { orderUpdates: OrderTracking }];

    expect(channel).toBe('orderUpdates');
    expect(payload.orderUpdates.id).toBe(context.id);
    expect(payload.orderUpdates.status).toBe(OrderStatus.SHIPPED);
    expect(payload.orderUpdates.trackingNumber).toBe(TTN);
  });

  it("keeps which of us pressed the button out of the customer's timeline", async () => {
    const context = await paid();

    await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: TTN,
      byUid: 'admin-1',
    });

    // Recorded on the document...
    const stored = context.store.get(context.id);
    expect(stored.events[stored.events.length - 1].byUid).toBe('admin-1');

    // ...and not on what the customer reads.
    const order = await context.orders.getOrder(context.id, 'uid-1');
    for (const entry of order.events) {
      expect(entry).not.toHaveProperty('byUid');
    }
  });

  it('reads a waybill number copied with the spaces in', async () => {
    const context = await paid();

    const order = await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: ' 2045 0912 3456 78 ',
      byUid: 'admin-1',
    });

    expect(order.trackingNumber).toBe(TTN);
  });

  it('refuses a Nova Poshta number that is not fourteen digits', async () => {
    const context = await paid();

    for (const bad of [
      '',
      '2045091234567',
      '204509123456789',
      'RA123456789UA',
    ]) {
      await expect(
        context.orders.markOrderShipped({
          orderId: context.id,
          trackingNumber: bad,
          byUid: 'admin-1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('takes another carrier at its word', async () => {
    const context = await paid({
      delivery: {
        ...DELIVERY,
        method: DeliveryMethod.UKRPOSHTA,
        address: null,
        comment: null,
      },
    });

    const order = await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: 'RA123456789UA',
      byUid: 'admin-1',
    });

    expect(order.trackingNumber).toBe('RA123456789UA');
  });

  it('will not ship something nobody has paid for', async () => {
    const context = setup();
    const { order } = await context.orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });

    await expect(
      context.orders.markOrderShipped({
        orderId: order.id,
        trackingNumber: TTN,
        byUid: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('will not ship something already called off', async () => {
    const context = await paid({ status: OrderStatus.CANCELLED });

    await expect(
      context.orders.markOrderShipped({
        orderId: context.id,
        trackingNumber: TTN,
        byUid: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('corrects a mistyped number without dispatching twice', async () => {
    const context = await paid();
    await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: TTN,
      byUid: 'admin-1',
    });
    const afterFirst = context.store.get(context.id).events.length;

    const corrected = await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: '20450912345679',
      byUid: 'admin-1',
    });

    expect(corrected.trackingNumber).toBe('20450912345679');
    expect(corrected.status).toBe(OrderStatus.SHIPPED);
    expect(context.store.get(context.id).events.length).toBe(afterFirst + 1);
  });

  it('says nothing twice when the same number is sent again', async () => {
    const context = await paid();
    await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: TTN,
      byUid: 'admin-1',
    });
    const events = context.store.get(context.id).events.length;

    await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: ' 2045-0912-3456-78 ',
      byUid: 'admin-1',
    });

    expect(context.store.get(context.id).events.length).toBe(events);
  });

  it('closes out an order that arrived, and only one that went out', async () => {
    const context = await paid();

    await expect(
      context.orders.markOrderDelivered({
        orderId: context.id,
        byUid: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: TTN,
      byUid: 'admin-1',
    });

    const delivered = await context.orders.markOrderDelivered({
      orderId: context.id,
      byUid: 'admin-1',
    });
    expect(delivered.status).toBe(OrderStatus.DELIVERED);

    // Asking twice is the same answer, not an error to explain.
    const again = await context.orders.markOrderDelivered({
      orderId: context.id,
      byUid: 'admin-1',
    });
    expect(again.status).toBe(OrderStatus.DELIVERED);
  });

  it('finds the order however the number was typed, or says it has none', async () => {
    const context = await paid();

    const order = await context.orders.markOrderShipped({
      orderId: ` ${context.id.toLowerCase()} `,
      trackingNumber: TTN,
      byUid: 'admin-1',
    });
    expect(order.id).toBe(context.id);

    await expect(
      context.orders.markOrderDelivered({
        orderId: 'NOSUCHID',
        byUid: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('working through the orders, as us', () => {
  async function ordersInStates(states: OrderStatus[]) {
    const context = setup();
    const ids: string[] = [];

    for (const [index, status] of states.entries()) {
      const { order } = await context.orders.placeOrder({
        input: ONE_TRACKER,
        uid: `uid-${index}`,
      });
      context.store.set(order.id, {
        ...context.store.get(order.id),
        status,
        // Placed a minute apart, oldest first, so "newest first" is a claim
        // the assertions can actually catch being wrong.
        createdAt: Timestamp.fromDate(new Date(2026, 0, 1, 0, index)),
      } as OrderDoc);
      ids.push(order.id);
    }

    return { ...context, ids };
  }

  it('lists what is waiting to be packed, whoever it belongs to', async () => {
    const context = await ordersInStates([
      OrderStatus.PAID,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PAID,
      OrderStatus.SHIPPED,
    ]);

    const paid = await context.orders.listOrders({ status: OrderStatus.PAID });

    expect(paid.map((order) => order.id).sort()).toEqual(
      [context.ids[0], context.ids[2]].sort(),
    );
    // Every one of them belongs to somebody else.
    expect(paid.every((order) => order.delivery !== null)).toBe(true);
  });

  it('answers newest first, and everything when no status is given', async () => {
    const context = await ordersInStates([
      OrderStatus.PAID,
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
    ]);

    const all = await context.orders.listOrders();

    expect(all).toHaveLength(3);
    expect(all.map((order) => order.id)).toEqual([...context.ids].reverse());
  });

  it('never reads more than it was asked for, or more than the cap', async () => {
    const context = await ordersInStates([
      OrderStatus.PAID,
      OrderStatus.PAID,
      OrderStatus.PAID,
    ]);

    expect(await context.orders.listOrders({ limit: 2 })).toHaveLength(2);

    // Nonsense bounds land inside the allowed range rather than throwing:
    // this is our own console, and an empty page helps nobody.
    expect(await context.orders.listOrders({ limit: 0 })).toHaveLength(1);
    expect(await context.orders.listOrders({ limit: -5 })).toHaveLength(1);
    expect(await context.orders.listOrders({ limit: 10_000 })).toHaveLength(3);
    expect(await context.orders.listOrders({ limit: NaN })).toHaveLength(3);
  });

  it('hands over the address to copy onto the waybill', async () => {
    const context = await ordersInStates([OrderStatus.PAID]);

    const order = await context.orders.getAnyOrder(
      ` ${context.ids[0].toLowerCase()} `,
    );

    expect(order?.delivery?.city).toBe('Львів');
    expect(order?.delivery?.branch).toBe('12');
    expect(order?.delivery?.recipientName).toBe('Олекса Цуцик');

    expect(await context.orders.getAnyOrder('NOSUCHID')).toBeNull();
  });

  it("is still the customer who cannot read somebody else's order", async () => {
    const context = await ordersInStates([OrderStatus.PAID]);

    await expect(
      context.orders.getOrder(context.ids[0], 'somebody-else'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('putting an order together', () => {
  async function paidOrder() {
    const context = setup();
    const { order } = await context.orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });
    context.store.set(order.id, {
      ...context.store.get(order.id),
      status: OrderStatus.PAID,
      paymentStatus: PaymentStatus.SUCCESS,
    } as OrderDoc);
    return { ...context, id: order.id };
  }

  it('freezes the address once somebody starts packing', async () => {
    const context = await paidOrder();

    const before = await context.orders.getOrder(context.id, 'uid-1');
    expect(before?.editable).toBe(true);

    const packing = await context.orders.markOrderInAssembly({
      orderId: context.id,
      byUid: 'admin-1',
    });

    expect(packing.status).toBe(OrderStatus.IN_ASSEMBLY);
    expect(packing.editable).toBe(false);

    await expect(
      context.orders.updateOrderDelivery({
        orderId: context.id,
        uid: 'uid-1',
        input: { ...DELIVERY, branch: '99' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not tell the customer it shipped when it is still on the table', async () => {
    const context = await paidOrder();
    await context.orders.markOrderInAssembly({
      orderId: context.id,
      byUid: 'admin-1',
    });

    await expect(
      context.orders.updateOrderContact({
        orderId: context.id,
        uid: 'uid-1',
        input: { phone: '+380671234500' },
      }),
    ).rejects.toThrow(/being put together/);
  });

  it('still lets a parcel that has gone nowhere be called off', async () => {
    const context = await paidOrder();
    const packing = await context.orders.markOrderInAssembly({
      orderId: context.id,
      byUid: 'admin-1',
    });

    expect(packing.cancellable).toBe(true);

    const cancelled = await context.orders.cancelOrder({
      orderId: context.id,
      uid: 'uid-1',
    });
    expect(cancelled.status).toBe(OrderStatus.REFUNDED);
  });

  it('will not start on something unpaid, and shrugs at being asked twice', async () => {
    const context = setup();
    const { order } = await context.orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });

    await expect(
      context.orders.markOrderInAssembly({
        orderId: order.id,
        byUid: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    context.store.set(order.id, {
      ...context.store.get(order.id),
      status: OrderStatus.IN_ASSEMBLY,
    } as OrderDoc);

    const events = context.store.get(order.id).events.length;
    const again = await context.orders.markOrderInAssembly({
      orderId: order.id,
      byUid: 'admin-1',
    });

    expect(again.status).toBe(OrderStatus.IN_ASSEMBLY);
    expect(context.store.get(order.id).events.length).toBe(events);
  });

  it('ships straight from assembly', async () => {
    const context = await paidOrder();
    await context.orders.markOrderInAssembly({
      orderId: context.id,
      byUid: 'admin-1',
    });

    const shipped = await context.orders.markOrderShipped({
      orderId: context.id,
      trackingNumber: '20450912345678',
      byUid: 'admin-1',
    });

    expect(shipped.status).toBe(OrderStatus.SHIPPED);
    expect(shipped.cancellable).toBe(false);
  });
});

describe('calling an order off, as us', () => {
  async function placed(monobank: FakeMonobank = fakeMonobank()) {
    const context = setup(monobank);
    const { order } = await context.orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });
    return { ...context, id: order.id };
  }

  type Placed = Awaited<ReturnType<typeof placed>>;

  async function markPaid(context: Placed) {
    await context.orders.applyInvoiceStatus({
      invoiceId: 'inv_1',
      status: 'success',
      amount: 490_000,
      ccy: 980,
      reference: context.id,
      modifiedDate: '2026-09-16T10:00:00Z',
    });
  }

  it('calls off an order that is not ours, without owning it', async () => {
    const context = await placed();

    const order = await context.orders.cancelAnyOrder({
      orderId: context.id,
      byUid: 'admin-1',
      reason: 'Немає з чого збирати',
    });

    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.cancelReason).toBe('Немає з чого збирати');
    expect(order.paymentPageUrl).toBeNull();
    expect(context.monobank.removeInvoice).toHaveBeenCalledWith('inv_1');
  });

  it('refunds a paid one through monobank, same as the customer would', async () => {
    const context = await placed();
    await markPaid(context);

    const order = await context.orders.cancelAnyOrder({
      orderId: context.id,
      byUid: 'admin-1',
    });

    expect(context.monobank.cancelInvoice).toHaveBeenCalledWith('inv_1');
    expect(order.status).toBe(OrderStatus.REFUNDED);
  });

  it('says in the timeline that we stopped it, not the customer', async () => {
    const context = await placed();

    await context.orders.cancelAnyOrder({
      orderId: context.id,
      byUid: 'admin-1',
    });

    const order = await context.orders.getOrder(context.id, 'uid-1');
    const last = order.events[order.events.length - 1];

    expect(last.actor).toBe(OrderActor.ADMIN);
    // Which of us pressed the button is stored, and still not the
    // customer's business — the same bargain dispatch strikes.
    expect(context.store.get(context.id).events.at(-1)?.byUid).toBe('admin-1');
    expect(last).not.toHaveProperty('byUid');
  });

  it('tells whoever is watching the order', async () => {
    const context = await placed();
    const publish = jest.spyOn(context.orders.getPubSub(), 'publish');

    await context.orders.cancelAnyOrder({
      orderId: context.id,
      byUid: 'admin-1',
    });

    const [channel, payload] = publish.mock.calls[
      publish.mock.calls.length - 1
    ] as [string, { orderUpdates: OrderTracking }];

    expect(channel).toBe('orderUpdates');
    expect(payload.orderUpdates.status).toBe(OrderStatus.CANCELLED);
  });

  it('will not call back a parcel that has gone out', async () => {
    const context = await placed();
    await markPaid(context);
    context.store.set(context.id, {
      ...context.store.get(context.id),
      status: OrderStatus.SHIPPED,
    } as OrderDoc);

    await expect(
      context.orders.cancelAnyOrder({ orderId: context.id, byUid: 'admin-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('leaves the order alone when monobank refuses the refund', async () => {
    const context = await placed(
      fakeMonobank({
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'failure' }),
      }),
    );
    await markPaid(context);

    await expect(
      context.orders.cancelAnyOrder({ orderId: context.id, byUid: 'admin-1' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(context.store.get(context.id).status).toBe(OrderStatus.PAID);
  });

  it('has nothing to call off when there is no such order', async () => {
    const context = await placed();

    await expect(
      context.orders.cancelAnyOrder({ orderId: 'NOSUCHID', byUid: 'admin-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('following an order without the app', () => {
  async function placedOrder() {
    const context = setup();
    const { order } = await context.orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });
    return { ...context, id: order.id };
  }

  it('is found by its number in whatever case it was typed', async () => {
    const { orders, id } = await placedOrder();

    const order = await orders.getOrder(id.toLowerCase(), 'uid-1');
    expect(order?.id).toBe(id);

    const tracking = await orders.getOrderTracking(
      ` ${id.toLowerCase()} `,
      '0671234567',
    );
    expect(tracking?.id).toBe(id);
  });

  it('answers an order number and a phone, and nothing else', async () => {
    const { orders, id } = await placedOrder();

    const tracking = await orders.getOrderTracking(id, '+38 067 123 45 67');
    expect(tracking?.status).toBe(OrderStatus.PENDING_PAYMENT);

    expect(await orders.getOrderTracking(id, '0000000000')).toBeNull();
    expect(await orders.getOrderTracking('NOSUCHID', '0671234567')).toBeNull();
  });
});

describe('reconciling pending payments', () => {
  it('asks monobank about invoices whose webhook never came', async () => {
    const monobank = fakeMonobank({
      getInvoiceStatus: jest.fn().mockResolvedValue({
        invoiceId: 'inv_1',
        status: 'expired',
        amount: 490_000,
        ccy: 980,
      }),
    });
    const { orders, store } = setup(monobank);
    const { order } = await orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });

    // Age the order past the invoice window.
    const stale = store.get(order.id);
    store.set(order.id, {
      ...stale,
      updatedAt: Timestamp.fromDate(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    } as OrderDoc);

    expect(await orders.reconcilePendingPayments()).toBe(1);
    expect(monobank.getInvoiceStatus).toHaveBeenCalledWith('inv_1');

    const refreshed = await orders.getOrder(order.id, 'uid-1');
    expect(refreshed?.paymentStatus).toBe(PaymentStatus.EXPIRED);
  });

  it('does nothing when acquiring is not configured', async () => {
    const monobank = fakeMonobank({ configured: false });
    const { orders } = setup(monobank);
    expect(await orders.reconcilePendingPayments()).toBe(0);
  });
});
