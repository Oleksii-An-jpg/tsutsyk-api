import { Resolver, Query, Subscription, Args } from '@nestjs/graphql';
import { TrackerService } from './tracker.service';
// Import the generated class/interface from your definitions factory
import { Location } from '../graphql.schema';

@Resolver('Location')
export class TrackerResolvers {
  constructor(private readonly trackerService: TrackerService) {}

  @Query('getTsutsykHistory')
  async getHistory(@Args('sessionId') sessionId: string): Promise<Location[]> {
    const history = await this.trackerService.getLocationHistory(sessionId);

    // Map Prisma Date objects to Strings for GraphQL
    return history.map((point) => ({
      ...point,
      timestamp: point.timestamp.toISOString(),
    }));
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  locationUpdates(@Args('sessionId') sessionId: string) {
    return this.trackerService
      .getPubSub()
      .asyncIterableIterator('locationUpdates');
  }
}
