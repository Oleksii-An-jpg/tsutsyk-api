import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PubSub } from 'graphql-subscriptions';
import {
  Location as GqlLocation,
  Session as GqlSession,
  SessionStatus,
} from '../graphql.schema';
import { SessionStatus as PrismaSessionStatus } from '@prisma/client';

@Injectable()
export class TrackerService {
  private readonly pubSub = new PubSub();
  constructor(private prisma: PrismaService) {}

  // Helper to convert Prisma enum to GraphQL enum
  private mapSessionStatus(status: PrismaSessionStatus): SessionStatus {
    return status as unknown as SessionStatus;
  }

  async recordSingleLocation({
    sessionId,
    tsutsykId,
    lat,
    lng,
    battery,
  }: {
    tsutsykId: string;
    sessionId: string;
    lat: number;
    lng: number;
    battery?: number;
  }): Promise<GqlLocation> {
    // 1. Auto-create session if it doesn't exist (plug-and-play!)
    await this.ensureSessionExists(tsutsykId, sessionId);

    // 2. Create the location point
    const newPoint = await this.prisma.location.create({
      data: {
        latitude: lat,
        longitude: lng,
        sessionId: sessionId,
        battery: battery,
        timestamp: new Date(),
      },
    });

    const gqlPoint: GqlLocation = {
      ...newPoint,
      timestamp: newPoint.timestamp.toISOString(),
    };

    // 3. Publish to subscribers
    await this.pubSub.publish('locationUpdates', { locationUpdates: gqlPoint });

    return gqlPoint;
  }

  async ensureSessionExists(tsutsykId: string, sessionId: string) {
    const existing = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (existing) return; // already created, nothing to do

    // New session — close any other active ones first
    await this.prisma.session.updateMany({
      where: {
        tsutsykId,
        status: SessionStatus.ACTIVE,
      },
      data: {
        status: SessionStatus.COMPLETED,
        endTime: new Date(),
      },
    });

    await this.prisma.session.create({
      data: {
        id: sessionId,
        status: SessionStatus.ACTIVE,
        tsutsyk: {
          connectOrCreate: {
            where: { id: tsutsykId },
            create: { id: tsutsykId },
          },
        },
      },
    });
  }

  async getTsutsykSessions(tsutsykId: string): Promise<GqlSession[]> {
    const sessions = await this.prisma.session.findMany({
      where: { tsutsykId },
      include: {
        locations: {
          orderBy: { timestamp: 'asc' },
        },
      },
      orderBy: { startTime: 'desc' },
    });

    return sessions.map((s) => ({
      id: s.id,
      tsutsykId: s.tsutsykId,
      startTime: s.startTime.toISOString(),
      endTime: s.endTime?.toISOString() || null,
      status: this.mapSessionStatus(s.status),
      locationCount: s.locations.length,
      locations: s.locations.map((l) => ({
        ...l,
        timestamp: l.timestamp.toISOString(),
      })),
    }));
  }

  async getSession(sessionId: string): Promise<GqlSession | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        locations: {
          orderBy: { timestamp: 'asc' },
        },
      },
    });

    if (!session) return null;

    return {
      id: session.id,
      tsutsykId: session.tsutsykId,
      startTime: session.startTime.toISOString(),
      endTime: session.endTime?.toISOString() || null,
      status: this.mapSessionStatus(session.status),
      locationCount: session.locations.length,
      locations: session.locations.map((l) => ({
        ...l,
        timestamp: l.timestamp.toISOString(),
      })),
    };
  }

  async getActiveSession(tsutsykId: string): Promise<GqlSession | null> {
    const session = await this.prisma.session.findFirst({
      where: {
        tsutsykId,
        status: SessionStatus.ACTIVE,
      },
      include: {
        locations: {
          orderBy: { timestamp: 'desc' },
          take: 1, // Just latest location for active session
        },
      },
      orderBy: { startTime: 'desc' },
    });

    if (!session) return null;

    return {
      id: session.id,
      tsutsykId: session.tsutsykId,
      startTime: session.startTime.toISOString(),
      endTime: null,
      status: this.mapSessionStatus(session.status),
      locationCount: await this.prisma.location.count({
        where: { sessionId: session.id },
      }),
      locations: session.locations.map((l) => ({
        ...l,
        timestamp: l.timestamp.toISOString(),
      })),
    };
  }

  async endSession(sessionId: string): Promise<GqlSession> {
    const session = await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.COMPLETED,
        endTime: new Date(),
      },
      include: {
        locations: true,
      },
    });

    return {
      id: session.id,
      tsutsykId: session.tsutsykId,
      startTime: session.startTime.toISOString(),
      endTime: session.endTime?.toISOString() || null,
      status: this.mapSessionStatus(session.status),
      locationCount: session.locations.length,
      locations: session.locations.map((l) => ({
        ...l,
        timestamp: l.timestamp.toISOString(),
      })),
    };
  }

  // Existing methods...
  async getLocationHistory(sessionId: string) {
    return this.prisma.location.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'asc' },
    });
  }

  async autoEndInactiveSessions() {
    const thresholdMinutes = 30; // No updates for 30 minutes = auto-end
    const threshold = new Date();
    threshold.setMinutes(threshold.getMinutes() - thresholdMinutes);

    // Find active sessions with no recent locations
    const inactiveSessions = await this.prisma.session.findMany({
      where: {
        status: SessionStatus.ACTIVE,
        locations: {
          some: {},
          every: {
            timestamp: {
              lt: threshold, // All locations older than threshold
            },
          },
        },
      },
      include: {
        locations: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
      },
    });

    // End each inactive session
    for (const session of inactiveSessions) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: {
          status: SessionStatus.COMPLETED,
          endTime: new Date(),
        },
      });

      console.log(`Auto-ended inactive session: ${session.id}`);
    }

    return inactiveSessions.length;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleInactiveSessions() {
    const count = await this.autoEndInactiveSessions();
    if (count > 0) {
      console.log(`Auto-ended ${count} inactive sessions`);
    }
  }

  getPubSub() {
    return this.pubSub;
  }
}
