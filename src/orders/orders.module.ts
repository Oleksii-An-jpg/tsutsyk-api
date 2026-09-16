import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { MonobankService } from './monobank.service';
import { OrdersController } from './orders.controller';
import { OrdersResolvers } from './orders.resolvers';
import { OrdersService } from './orders.service';

@Module({
  imports: [FirestoreModule],
  providers: [OrdersResolvers, OrdersService, MonobankService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
