import { Resolver, Query, Mutation, Subscription, Args } from '@nestjs/graphql';
import { TrackerService } from './tracker.service';
import { Location, Session } from '../graphql.schema';

@Resolver('Location')
export class TrackerResolvers {
  constructor(private readonly trackerService: TrackerService) {}

  // Session Queries
  @Query('getTsutsykSessions')
  async getTsutsykSessions(
    @Args('tsutsykId') tsutsykId: string,
  ): Promise<Session[]> {
    return this.trackerService.getTsutsykSessions(tsutsykId);
  }

  @Query('getSession')
  async getSession(@Args('sessionId') sessionId: string): Promise<Session> {
    return this.trackerService.getSession(sessionId);
  }

  @Query('getActiveSession')
  async getActiveSession(
    @Args('tsutsykId') tsutsykId: string,
  ): Promise<Session> {
    return this.trackerService.getActiveSession(tsutsykId);
  }

  // Location Query
  @Query('getTsutsykHistory')
  async getHistory(@Args('sessionId') sessionId: string): Promise<Location[]> {
    const history = await this.trackerService.getLocationHistory(sessionId);
    return history.map((point) => ({
      ...point,
      timestamp: point.timestamp.toISOString(),
    }));
  }

  // Session Mutations
  @Mutation('endSession')
  async endSession(@Args('sessionId') sessionId: string): Promise<Session> {
    return this.trackerService.endSession(sessionId);
  }

  @Subscription('locationUpdates', {
    // Define the types for payload and variables
    filter: (
      payload: { locationUpdates: Location },
      variables: { sessionId: string },
    ) => {
      return payload.locationUpdates.sessionId === variables.sessionId;
    },
  })
  locationUpdates(@Args('sessionId') sessionId: string) {
    return this.trackerService
      .getPubSub()
      .asyncIterableIterator('locationUpdates');
  }

  // Location Mutation
  @Mutation('postLocation')
  async postLocation(
    @Args('tsutsykId') tsutsykId: string,
    @Args('sessionId') sessionId: string,
    @Args('lat') lat: number,
    @Args('lng') lng: number,
    @Args('battery') battery: number,
  ): Promise<Location> {
    const newPoint = await this.trackerService.recordSingleLocation({
      tsutsykId,
      sessionId,
      battery,
      lat,
      lng,
    });

    await this.trackerService.getPubSub().publish('locationUpdates', {
      locationUpdates: newPoint,
    });

    return newPoint;
  }
}
