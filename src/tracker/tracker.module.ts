import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TrackerResolvers } from './tracker.resolvers';
import { TrackerService } from './tracker.service';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  providers: [TrackerResolvers, TrackerService],
  imports: [PrismaModule, ScheduleModule.forRoot()],
  controllers: [],
})
export class TrackerModule {}
