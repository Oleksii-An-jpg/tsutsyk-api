import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PubSub } from 'graphql-subscriptions';
import { Location as PrismaLocation } from '@prisma/client';
import { Location as GqlLocation } from '../graphql.schema';

type PubSubEvents = {
  locationUpdates: { locationUpdates: GqlLocation };
};

@Injectable()
export class TrackerService {
  // Type the PubSub instance properly
  private readonly pubSub = new PubSub<PubSubEvents>();
  constructor(private prisma: PrismaService) {}

  async recordLocations(
    tsutsykId: string,
    sessionId: string,
    points: { lat: number; lng: number; time?: string }[],
  ) {
    // 1. Ensure Tsutsyk and Session exist (Upsert logic)
    await this.prisma.session.upsert({
      where: { id: sessionId },
      update: {},
      create: {
        id: sessionId,
        tsutsyk: {
          connectOrCreate: {
            where: { id: tsutsykId },
            create: { id: tsutsykId },
          },
        },
      },
    });

    // 2. Batch Insert for Performance
    const data = points.map((p) => ({
      latitude: p.lat,
      longitude: p.lng,
      timestamp: p.time ? new Date(p.time) : new Date(),
      sessionId: sessionId,
    }));

    await this.prisma.location.createMany({ data });

    const latestPoint = points[points.length - 1];

    // Explicitly format the object to match GqlLocation
    const payload: GqlLocation = {
      id: 0, // Or the actual ID from Prisma if you perform a single create
      latitude: latestPoint.lat,
      longitude: latestPoint.lng,
      sessionId: sessionId,
      timestamp: new Date().toISOString(), // Match the String type in your schema
    };

    this.pubSub.publish('locationUpdates', { locationUpdates: payload });

    return { count: points.length };

    return { count: data.length };
  }

  async getLocationHistory(sessionId: string): Promise<PrismaLocation[]> {
    return this.prisma.location.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'asc' },
    });
  }

  getPubSub() {
    return this.pubSub;
  }
}
