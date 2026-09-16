import {
  Args,
  Context,
  Mutation,
  Query,
  Resolver,
  Subscription,
} from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import {
  CurrentUser,
  CurrentUserOptional,
} from '../auth/current-user.decorator';
import { OptionalFirebaseAuthGuard } from '../auth/optional-firebase-auth.guard';
import {
  DeliveryInput,
  Order,
  OrderContactInput,
  OrderPayment,
  OrderTracking,
  PlaceOrderInput,
  Product,
} from '../graphql.schema';
import { ORDER_UPDATES, OrdersService } from './orders.service';

interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * The origin this deployment is reachable on, for the callback URLs monobank
 * uses. `API_PUBLIC_URL` wins; this is the fallback that lets a preview
 * deployment (or a tunnel, during development) work unconfigured.
 */
function originOf(req?: RequestLike): string | null {
  const header = (name: string): string | undefined => {
    const value = req?.headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const host = header('x-forwarded-host') ?? header('host');
  if (!host) return null;

  return `${header('x-forwarded-proto') ?? 'https'}://${host}`;
}

@Resolver('Order')
export class OrdersResolvers {
  constructor(private readonly orders: OrdersService) {}

  // ─── Queries ──────────────────────────────────────────────────────────

  @Query('getProducts')
  getProducts(): Product[] {
    return this.orders.listProducts();
  }

  @UseGuards(FirebaseAuthGuard)
  @Query('getMyOrders')
  async getMyOrders(@CurrentUser() uid: string): Promise<Order[]> {
    return this.orders.getMyOrders(uid);
  }

  @UseGuards(FirebaseAuthGuard)
  @Query('getOrder')
  async getOrder(
    @CurrentUser() uid: string,
    @Args('id') id: string,
  ): Promise<Order> {
    return this.orders.getOrder(id, uid);
  }

  @Query('getOrderTracking')
  async getOrderTracking(
    @Args('id') id: string,
    @Args('phone') phone: string,
  ): Promise<OrderTracking> {
    return this.orders.getOrderTracking(id, phone);
  }

  // ─── Mutations ────────────────────────────────────────────────────────

  @UseGuards(OptionalFirebaseAuthGuard)
  @Mutation('placeOrder')
  async placeOrder(
    @CurrentUserOptional() uid: string | null,
    @Args('input') input: PlaceOrderInput,
    @Context('req') req: RequestLike,
  ): Promise<OrderPayment> {
    return this.orders.placeOrder({
      input,
      uid,
      requestOrigin: originOf(req),
    });
  }

  @UseGuards(FirebaseAuthGuard)
  @Mutation('retryOrderPayment')
  async retryOrderPayment(
    @CurrentUser() uid: string,
    @Args('orderId') orderId: string,
    @Args('redirectUrl') redirectUrl: string | null,
    @Context('req') req: RequestLike,
  ): Promise<OrderPayment> {
    return this.orders.retryOrderPayment({
      orderId,
      uid,
      redirectUrl,
      requestOrigin: originOf(req),
    });
  }

  @UseGuards(FirebaseAuthGuard)
  @Mutation('claimOrder')
  async claimOrder(
    @CurrentUser() uid: string,
    @Args('orderId') orderId: string,
    @Args('phone') phone: string | null,
  ): Promise<Order> {
    return this.orders.claimOrder({ orderId, uid, phone });
  }

  @UseGuards(FirebaseAuthGuard)
  @Mutation('updateOrderDelivery')
  async updateOrderDelivery(
    @CurrentUser() uid: string,
    @Args('orderId') orderId: string,
    @Args('input') input: DeliveryInput,
  ): Promise<Order> {
    return this.orders.updateOrderDelivery({ orderId, uid, input });
  }

  @UseGuards(FirebaseAuthGuard)
  @Mutation('updateOrderContact')
  async updateOrderContact(
    @CurrentUser() uid: string,
    @Args('orderId') orderId: string,
    @Args('input') input: OrderContactInput,
  ): Promise<Order> {
    return this.orders.updateOrderContact({ orderId, uid, input });
  }

  @UseGuards(FirebaseAuthGuard)
  @Mutation('cancelOrder')
  async cancelOrder(
    @CurrentUser() uid: string,
    @Args('orderId') orderId: string,
    @Args('reason') reason: string | null,
  ): Promise<Order> {
    return this.orders.cancelOrder({ orderId, uid, reason });
  }

  @UseGuards(FirebaseAuthGuard)
  @Mutation('refreshOrderPayment')
  async refreshOrderPayment(
    @CurrentUser() uid: string,
    @Args('orderId') orderId: string,
  ): Promise<Order> {
    return this.orders.refreshOrderPayment(orderId, uid);
  }

  // ─── Subscription ─────────────────────────────────────────────────────

  @Subscription(ORDER_UPDATES, {
    filter: (
      payload: { orderUpdates: OrderTracking },
      variables: { orderId: string },
    ) =>
      payload.orderUpdates.id.toUpperCase() ===
      String(variables.orderId).toUpperCase(),
  })
  // `orderId` is not read here on purpose: the schema validates it and the
  // filter above matches on it, so binding it would only be an unused arg.
  orderUpdates() {
    return this.orders.getPubSub().asyncIterableIterator(ORDER_UPDATES);
  }
}
