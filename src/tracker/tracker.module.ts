import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TrackerResolvers } from './tracker.resolvers';
import { TrackerService } from './tracker.service';
import { IngestController } from './tracker.controller';

@Module({
  providers: [TrackerResolvers, TrackerService],
  imports: [PrismaModule],
  controllers: [IngestController],
})
export class TrackerModule {}
