import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DateTimeResolver, DateResolver } from 'graphql-scalars';
import { AlertsModule } from './alerts/alerts.module';
import { TrackerModule } from './tracker/tracker.module';
import { OrdersModule } from './orders/orders.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AirRaidStatus, SessionStatus } from './graphql.schema';

@Module({
  imports: [
    ConfigModule.forRoot(),
    // Registered once, here: a second forRoot() would set up a second
    // scheduler explorer and fire every @Cron twice.
    ScheduleModule.forRoot(),
    AlertsModule,
    TrackerModule,
    OrdersModule,
    NotificationsModule,
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typePaths: ['./**/*.graphql'],
      subscriptions: {
        'graphql-ws': {
          path: '/graphql',
        },
      },
      context: ({ req }: { req: unknown }) => ({ req }),
      introspection: true,
      resolvers: {
        DateTime: DateTimeResolver,
        Date: DateResolver,
        SessionStatus: {
          ACTIVE: SessionStatus.ACTIVE,
          COMPLETED: SessionStatus.COMPLETED,
        },
        AirRaidStatus: {
          ACTIVE: AirRaidStatus.ACTIVE,
          PARTLY: AirRaidStatus.PARTLY,
          NO_ALERT: AirRaidStatus.NO_ALERT,
          UNKNOWN: AirRaidStatus.UNKNOWN,
        },
      },
    }),
  ],
})
export class AppModule {}
