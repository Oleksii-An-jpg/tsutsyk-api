import { Timestamp } from 'firebase-admin/firestore';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
  OrderStatus,
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

class FakeQuery {
  constructor(
    private readonly store: Map<string, OrderDoc>,
    private readonly filters: [keyof OrderDoc, string, unknown][] = [],
    private readonly max?: number,
  ) {}

  where(field: keyof OrderDoc, op: string, value: unknown) {
    return new FakeQuery(
      this.store,
      [...this.filters, [field, op, value]],
      this.max,
    );
  }

  orderBy() {
    return this;
  }

  limit(max: number) {
    return new FakeQuery(this.store, this.filters, max);
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

const ONE_TRACKER: PlaceOrderInput = {
  items: [{ productId: 'tsutsyk-tracker', quantity: 1 }],
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
      input: { items: [{ productId: 'tsutsyk-tracker', quantity: 2 }] },
      uid: null,
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
          items: [
            { productId: 'tsutsyk-tracker', quantity: 2 },
            { productId: 'tsutsyk-tracker', quantity: 2 },
          ],
        },
        uid: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a product nobody sells', async () => {
    const { orders } = setup();
    await expect(
      orders.placeOrder({
        input: { items: [{ productId: 'free-tracker', quantity: 1 }] },
        uid: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('attaches the order to the caller when they are signed in', async () => {
    const { orders, store } = setup();
    const { order } = await orders.placeOrder({
      input: ONE_TRACKER,
      uid: 'uid-1',
    });
    expect(store.get(order.id)?.ownerUid).toBe('uid-1');
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
        uid: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to send a paying customer off to a foreign origin', async () => {
    const { orders } = setup();
    await expect(
      orders.placeOrder({
        input: { ...ONE_TRACKER, redirectUrl: 'https://evil.example/thanks' },
        uid: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('opens the payment page with the order number in the return URL', async () => {
    const { orders, monobank } = setup();
    const { order } = await orders.placeOrder({
      input: { ...ONE_TRACKER, redirectUrl: 'https://tsutsyk.live/' },
      uid: null,
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
      input: {
        ...ONE_TRACKER,
        contact: { phone: '+380671234567' },
      },
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

describe('guest orders', () => {
  async function guestOrder() {
    const context = setup();
    const { order } = await context.orders.placeOrder({
      input: { ...ONE_TRACKER, contact: { phone: '+380671234567' } },
      uid: null,
    });
    return { ...context, id: order.id };
  }

  it('is claimed by the buyer once they sign in', async () => {
    const { orders, id } = await guestOrder();

    const order = await orders.claimOrder({
      orderId: id.toLowerCase(), // typed in by hand, in whatever case
      uid: 'uid-9',
      phone: '0671234567',
    });

    expect(order.id).toBe(id);
    expect(await orders.getOrder(id, 'uid-9')).not.toBeNull();
  });

  it('is found by its number in whatever case it was typed', async () => {
    const { orders, id } = await guestOrder();
    await orders.claimOrder({ orderId: id, uid: 'uid-9', phone: '0671234567' });

    const order = await orders.getOrder(id.toLowerCase(), 'uid-9');
    expect(order?.id).toBe(id);

    const tracking = await orders.getOrderTracking(
      ` ${id.toLowerCase()} `,
      '0671234567',
    );
    expect(tracking?.id).toBe(id);
  });

  it('is not claimed by somebody with the wrong phone', async () => {
    const { orders, id } = await guestOrder();

    await expect(
      orders.claimOrder({ orderId: id, uid: 'uid-9', phone: '0670000000' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cannot be claimed twice', async () => {
    const { orders, id } = await guestOrder();
    await orders.claimOrder({ orderId: id, uid: 'uid-9', phone: '0671234567' });

    await expect(
      orders.claimOrder({ orderId: id, uid: 'uid-10', phone: '0671234567' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('can be followed with an order number and a phone, and nothing else', async () => {
    const { orders, id } = await guestOrder();

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
