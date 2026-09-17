import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { InvoiceWebhookPayload, MonobankService } from './monobank.service';
import { OrdersService } from './orders.service';

/**
 * monobank invoice callbacks.
 *
 * This is the only trustworthy signal that a payment happened. A buyer coming
 * back to `redirectUrl` means only that they came back — a browser can be sent
 * there without paying anything.
 *
 * monobank retries anything that is not a 2xx, so the only failures answered
 * with an error are the ones a retry could actually fix.
 */
@Controller('payments/monobank')
export class OrdersController {
  private readonly logger = new Logger(OrdersController.name);

  constructor(
    private readonly monobank: MonobankService,
    private readonly orders: OrdersService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-sign') signature?: string,
  ): Promise<void> {
    // The signature covers exactly the bytes monobank sent: re-serialising the
    // parsed JSON changes key order and whitespace, and would never match.
    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody) {
      throw new BadRequestException('Empty body');
    }

    let verified: boolean;
    try {
      verified = await this.monobank.verifyWebhookSignature(rawBody, signature);
    } catch (error) {
      // Could not reach monobank for the public key. 503 so the callback is
      // redelivered once we can verify it again.
      this.logger.error('could not verify the webhook signature', error);
      throw new ServiceUnavailableException('Verification unavailable');
    }

    if (!verified) {
      this.logger.warn('rejected a webhook with a bad signature');
      throw new UnauthorizedException('Invalid signature');
    }

    let payload: InvoiceWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as InvoiceWebhookPayload;
    } catch {
      // Signed but unparseable — retrying will not help.
      throw new BadRequestException('Malformed payload');
    }

    if (!payload.invoiceId || !payload.status) {
      throw new BadRequestException('Missing invoiceId or status');
    }

    try {
      await this.orders.applyInvoiceStatus(payload);
    } catch (error) {
      // Storage failure — 503 so monobank redelivers, rather than letting a
      // paid order vanish.
      this.logger.error('failed to record a webhook', error);
      throw new ServiceUnavailableException('Storage error');
    }
  }
}
