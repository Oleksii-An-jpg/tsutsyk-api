import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule } from '@nestjs/config';
import { DateTimeResolver, DateResolver } from 'graphql-scalars';
import { TrackerModule } from './tracker/tracker.module';
import { SessionStatus } from './graphql.schema';

@Module({
  imports: [
    ConfigModule.forRoot(),
    TrackerModule,
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
      },
    }),
  ],
})
export class AppModule {}
