import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GadgetsService } from './gadgets.service';
import { GqlAdminGuard } from '../auth/gql-admin.guard';
import { TrackerService } from '../tracker/tracker.service';
import { GadgetStatus as GqlGadgetStatus, Tsutsyk } from '../graphql.schema';

@Resolver('GadgetStatus')
export class GadgetsResolver {
  constructor(
    private readonly gadgets: GadgetsService,
    private readonly tracker: TrackerService,
  ) {}

  @Query('getGadgetStatus')
  async getGadgetStatus(
    @Args('id') id: string,
  ): Promise<GqlGadgetStatus | null> {
    return this.gadgets.getGadgetStatus(id);
  }

  @UseGuards(GqlAdminGuard)
  @Mutation('claimGadget')
  async claimGadget(
    @Args('id') id: string,
    @Context() ctx: { req: { uid: string } },
  ): Promise<Tsutsyk> {
    await this.gadgets.claimGadget(id, ctx.req.uid);
    return this.tracker.getTsutsyk(id);
  }
}
