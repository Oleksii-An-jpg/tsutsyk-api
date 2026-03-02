import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PubSub } from 'graphql-subscriptions';
import { Location as PrismaLocation } from '@prisma/client';
import { Location as GqlLocation } from '../graphql.schema';

type PubSubEvents = {
  locationUpdates: { locationUpdates: GqlLocation };
  tsutsykAlert: {
    message: string;
    tsutsykId: string;
  };
};

@Injectable()
export class TrackerService {
  // Type the PubSub instance properly
  private readonly pubSub = new PubSub<PubSubEvents>();
  constructor(private prisma: PrismaService) {}

  async recordLocations(
    tsutsykId: string,
    sessionId: string,
    points: { lat: number; battery: number; lng: number; time?: string }[],
  ) {
    // 1. Ensure the Session exists (Create it if missing)
    await this.prisma.session.upsert({
      where: { id: sessionId },
      update: {}, // If it exists, do nothing
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
      battery: p.battery,
    }));

    await this.prisma.location.createMany({ data });

    const latestPoint = points[points.length - 1];

    // Logic: If battery is low, fire an alert immediately
    if (latestPoint.battery && latestPoint.battery < 20) {
      await this.pubSub.publish('tsutsykAlert', {
        message: `Low Battery! ${latestPoint.battery}% remaining.`,
        tsutsykId,
      });
    }

    // Explicitly format the object to match GqlLocation
    const payload: GqlLocation = {
      id: 0, // Or the actual ID from Prisma if you perform a single create
      latitude: latestPoint.lat,
      longitude: latestPoint.lng,
      sessionId: sessionId,
      battery: latestPoint.battery,
      timestamp: new Date().toISOString(), // Match the String type in your schema
    };

    await this.pubSub.publish('locationUpdates', { locationUpdates: payload });

    return { count: points.length };
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
