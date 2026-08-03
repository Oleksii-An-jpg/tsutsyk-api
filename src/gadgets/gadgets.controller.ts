import {
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { GadgetsService } from './gadgets.service';

// Used by the flashing rig/script at production time, not by the web app.
// Gated by a shared key rather than a user token since no Firebase user
// exists yet at this point in a unit's lifecycle.
@Controller('gadgets')
export class GadgetsController {
  constructor(private readonly gadgets: GadgetsService) {}

  @Post('provision')
  async provision(@Headers('x-provisioning-key') key?: string) {
    const expectedKey = process.env.PROVISIONING_API_KEY;
    if (!expectedKey || key !== expectedKey) {
      throw new UnauthorizedException('Invalid or missing provisioning key');
    }

    return this.gadgets.provision();
  }
}
