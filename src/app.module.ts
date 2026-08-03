import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { DateTimeResolver, DateResolver } from 'graphql-scalars';
import { TrackerModule } from './tracker/tracker.module';
import { GadgetsModule } from './gadgets/gadgets.module';
import { SessionStatus } from '@prisma/client';

@Module({
  imports: [
    ConfigModule.forRoot(),
    TrackerModule,
    GadgetsModule,
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typePaths: ['./**/*.graphql'],
      subscriptions: {
        'graphql-ws': {
          path: '/graphql',
        },
      },
      introspection: true,
      resolvers: {
        DateTime: DateTimeResolver,
        Date: DateResolver,
        SessionStatus: {
          ACTIVE: SessionStatus.ACTIVE,
          COMPLETED: SessionStatus.COMPLETED,
        },
      },
    }),
  ],
  // providers: [
  //   {
  //     provide: APP_GUARD,
  //     useClass: GqlAuthGuard,
  //   },
  // ],
})
export class AppModule {}
