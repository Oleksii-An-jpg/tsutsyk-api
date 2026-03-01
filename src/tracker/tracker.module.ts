import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TrackerResolvers } from './tracker.resolvers';
import { TrackerService } from './tracker.service';

@Module({
  providers: [TrackerResolvers, TrackerService],
  imports: [PrismaModule],
})
export class TrackerModule {}
