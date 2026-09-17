import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { PushConfig, PushSubscriptionInput } from '../graphql.schema';

/** The subscribing browser's own description of itself, for the device list. */
const UserAgent = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null => {
    const req = GqlExecutionContext.create(context).getContext<{
      req?: { headers?: Record<string, string | undefined> };
    }>().req;
    return req?.headers?.['user-agent'] ?? null;
  },
);

@Resolver('PushConfig')
export class NotificationsResolvers {
  constructor(private readonly notifications: NotificationsService) {}

  @Query('getPushConfig')
  getPushConfig(): PushConfig {
    return { publicKey: this.notifications.getPublicKey() };
  }

  @UseGuards(FirebaseAuthGuard)
  @Mutation('savePushSubscription')
  async savePushSubscription(
    @CurrentUser() uid: string,
    @Args('input') input: PushSubscriptionInput,
    @UserAgent() userAgent: string | null,
  ): Promise<boolean> {
    await this.notifications.saveSubscription({
      uid,
      subscription: {
        endpoint: input.endpoint,
        keys: { p256dh: input.p256dh, auth: input.auth },
      },
      userAgent,
    });
    return true;
  }

  @UseGuards(FirebaseAuthGuard)
  @Mutation('deletePushSubscription')
  async deletePushSubscription(
    @CurrentUser() uid: string,
    @Args('endpoint') endpoint: string,
  ): Promise<boolean> {
    await this.notifications.deleteSubscription({ uid, endpoint });
    return true;
  }
}
