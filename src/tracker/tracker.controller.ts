import { Controller, Post, Body } from '@nestjs/common';
import { TrackerService } from './tracker.service';

@Controller('ingest')
export class IngestController {
  constructor(private readonly trackerService: TrackerService) {}

  @Post()
  async handleGpsData(
    @Body()
    body: {
      tsutsykId: string;
      sessionId: string;
      points: { lat: number; lng: number; time?: string }[];
    },
  ) {
    // This allows the tracker to send 1 point or 100 points in one go
    return await this.trackerService.recordLocations(
      body.tsutsykId,
      body.sessionId,
      body.points,
    );
  }
}
