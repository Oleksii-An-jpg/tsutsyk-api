import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { GeofenceService } from './geofence.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AlertArea, LatLngInput } from '../graphql.schema';

@Resolver('AlertArea')
@UseGuards(FirebaseAuthGuard)
export class GeofenceResolvers {
  constructor(private readonly geofence: GeofenceService) {}

  @Query('getAlertAreas')
  getAlertAreas(
    @CurrentUser() uid: string,
    @Args('tsutsykId') tsutsykId: string,
  ): Promise<AlertArea[]> {
    return this.geofence.listAreas(uid, tsutsykId);
  }

  @Mutation('createAlertArea')
  createAlertArea(
    @CurrentUser() uid: string,
    @Args('tsutsykId') tsutsykId: string,
    @Args('name') name: string,
    @Args('points') points: LatLngInput[],
  ): Promise<AlertArea> {
    return this.geofence.createArea({ uid, tsutsykId, name, points });
  }

  @Mutation('updateAlertArea')
  updateAlertArea(
    @CurrentUser() uid: string,
    @Args('tsutsykId') tsutsykId: string,
    @Args('id') id: string,
    @Args('name') name?: string | null,
    @Args('points') points?: LatLngInput[] | null,
    @Args('enabled') enabled?: boolean | null,
  ): Promise<AlertArea> {
    return this.geofence.updateArea({
      uid,
      tsutsykId,
      id,
      name,
      points,
      enabled,
    });
  }

  @Mutation('deleteAlertArea')
  deleteAlertArea(
    @CurrentUser() uid: string,
    @Args('tsutsykId') tsutsykId: string,
    @Args('id') id: string,
  ): Promise<boolean> {
    return this.geofence.deleteArea({ uid, tsutsykId, id });
  }
}
