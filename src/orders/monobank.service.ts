import { Injectable, Logger } from '@nestjs/common';
import { createVerify } from 'node:crypto';

/**
 * monobank internet acquiring.
 *
 * Creates invoices, reads their status, withdraws and refunds them, and
 * verifies webhook signatures.
 *
 * monobank signs the raw webhook body with the merchant key and sends the
 * base64 ECDSA-SHA256 signature in `X-Sign`. The matching public key comes from
 * `GET /api/merchant/pubkey`, which needs the merchant token.
 *
 * Docs: https://monobank.ua/api-docs/acquiring/dev/webhooks/verify
 */

export type InvoiceStatus =
  | 'created'
  | 'processing'
  | 'hold'
  | 'success'
  | 'failure'
  | 'reversed'
  | 'expired';

/** Response of `GET /api/merchant/invoice/status`, and the webhook body. */
export interface InvoiceStatusResponse {
  invoiceId: string;
  status: InvoiceStatus;
  failureReason?: string;
  amount: number;
  ccy: number;
  /** Our own order id, echoed back from `merchantPaymInfo.reference`. */
  reference?: string;
  createdDate?: string;
  /**
   * When monobank last changed this invoice. The docs are explicit that
   * webhooks are not delivered in order — a `success` can arrive before the
   * `processing` that preceded it — and that the payload with the later
   * `modifiedDate` is the current one. This field, not arrival order, decides
   * which status wins.
   */
  modifiedDate?: string;
}

/** The webhook body is identical to the status response. */
export type InvoiceWebhookPayload = InvoiceStatusResponse;

export interface BasketItem {
  name: string;
  qty: number;
  /** Line total in minor units (kopiykas). */
  sum: number;
  unit?: string;
  code?: string;
  icon?: string;
}

export interface CreateInvoiceInput {
  /** Total in minor units (kopiykas). */
  amount: number;
  ccy?: number;
  /** Our own order id. monobank echoes it back on every webhook. */
  reference: string;
  destination: string;
  comment?: string;
  basketOrder?: BasketItem[];
  /** Where the buyer returns after paying, success or failure alike. */
  redirectUrl: string;
  webHookUrl?: string;
  /** Seconds the invoice stays payable. Default 24h, capped at 30 days. */
  validity?: number;
}

export interface CreatedInvoice {
  invoiceId: string;
  pageUrl: string;
  appUrl?: string;
}

export interface CancelledInvoice {
  status: 'processing' | 'success' | 'failure';
  createdDate?: string;
  modifiedDate?: string;
}

/** ISO 4217 numeric code for the hryvnia. */
export const UAH = 980;

export class MonobankError extends Error {
  readonly status: number;
  readonly errCode?: string;

  constructor(message: string, status = 0, errCode?: string) {
    super(message);
    this.name = 'MonobankError';
    this.status = status;
    this.errCode = errCode;
  }
}

@Injectable()
export class MonobankService {
  private readonly logger = new Logger(MonobankService.name);

  // Memoised: the key only changes when the merchant rotates it, which is why
  // a failed check refetches once before giving up.
  private cachedPublicKey: string | null = null;

  private get apiBase(): string {
    return process.env.MONOBANK_API_BASE ?? 'https://api.monobank.ua';
  }

  /** Whether acquiring is configured at all — checkout 503s without it. */
  get configured(): boolean {
    return Boolean(process.env.MONOBANK_ACQUIRING_TOKEN);
  }

  private requireToken(): string {
    const token = process.env.MONOBANK_ACQUIRING_TOKEN;
    if (!token) {
      throw new MonobankError(
        'MONOBANK_ACQUIRING_TOKEN is not set — see .env.example',
      );
    }
    return token;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        'X-Token': this.requireToken(),
        // monobank asks integrations to identify themselves; it shows up in
        // the merchant dashboard and helps their support trace requests.
        'X-Cms': 'tsutsyk-api',
        'X-Cms-Version': '1.0.0',
        ...init?.headers,
      },
    });

    const body = await response.text();

    if (!response.ok) {
      // Errors come back as {errCode, errText}; fall back to the raw body when
      // monobank returns an HTML error page, which happens on 502s.
      let errText = body;
      let errCode: string | undefined;
      try {
        const parsed = JSON.parse(body) as {
          errCode?: string;
          errText?: string;
        };
        errCode = parsed.errCode;
        errText = parsed.errText ?? body;
      } catch {
        // keep the raw body
      }
      throw new MonobankError(
        `monobank ${path} failed: ${response.status} ${errText}`,
        response.status,
        errCode,
      );
    }

    return JSON.parse(body) as T;
  }

  /** Creates an invoice and returns the hosted page to send the buyer to. */
  createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
    const {
      amount,
      ccy = UAH,
      reference,
      destination,
      comment,
      basketOrder,
      redirectUrl,
      webHookUrl,
      validity,
    } = input;

    return this.call<CreatedInvoice>('/api/merchant/invoice/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount,
        ccy,
        merchantPaymInfo: {
          reference,
          destination,
          ...(comment ? { comment } : {}),
          ...(basketOrder ? { basketOrder } : {}),
        },
        // Only redirectUrl: successUrl and failUrl have to be enabled by
        // monobank support and are not available by default.
        redirectUrl,
        ...(webHookUrl ? { webHookUrl } : {}),
        ...(validity ? { validity } : {}),
      }),
    });
  }

  /**
   * Authoritative status straight from monobank. Also the only way to observe
   * `expired`, which the docs say is the one status that never sends a webhook.
   */
  getInvoiceStatus(invoiceId: string): Promise<InvoiceStatusResponse> {
    return this.call<InvoiceStatusResponse>(
      `/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`,
    );
  }

  /**
   * Withdraws an invoice that was never paid, so an abandoned payment page
   * cannot be completed after the customer has cancelled the order.
   */
  removeInvoice(invoiceId: string): Promise<unknown> {
    return this.call('/api/merchant/invoice/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId }),
    });
  }

  /**
   * Refunds a paid invoice. `amount` is optional — omitted, monobank returns
   * the whole thing, which is the only refund we offer today.
   */
  cancelInvoice(invoiceId: string, amount?: number): Promise<CancelledInvoice> {
    return this.call<CancelledInvoice>('/api/merchant/invoice/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoiceId,
        ...(amount ? { amount } : {}),
      }),
    });
  }

  private async fetchPublicKey(): Promise<string> {
    const response = await fetch(`${this.apiBase}/api/merchant/pubkey`, {
      headers: { 'X-Token': this.requireToken() },
    });

    if (!response.ok) {
      throw new Error(
        `could not fetch the monobank public key: ${response.status}`,
      );
    }

    const { key } = (await response.json()) as { key: string };
    // The endpoint returns the PEM itself, base64-encoded.
    return Buffer.from(key, 'base64').toString('utf8');
  }

  private async getPublicKey(forceRefresh = false): Promise<string> {
    if (!this.cachedPublicKey || forceRefresh) {
      this.cachedPublicKey = await this.fetchPublicKey();
    }
    return this.cachedPublicKey;
  }

  private verifyWith(publicKey: string, rawBody: string, signature: string) {
    try {
      return createVerify('SHA256')
        .update(rawBody, 'utf8')
        .verify(publicKey, signature, 'base64');
    } catch {
      // Malformed signature or key — "not verified", not a crash.
      return false;
    }
  }

  /**
   * Verifies a webhook against the merchant public key.
   *
   * `rawBody` must be the exact bytes monobank sent: re-serialising the parsed
   * JSON changes key order and whitespace, and the signature would never match.
   */
  async verifyWebhookSignature(
    rawBody: string,
    signature: string | null | undefined,
  ): Promise<boolean> {
    if (!signature) return false;

    if (this.verifyWith(await this.getPublicKey(), rawBody, signature)) {
      return true;
    }

    // Possible key rotation: refetch once and retry before rejecting.
    this.logger.warn('signature did not verify — refetching the public key');
    return this.verifyWith(await this.getPublicKey(true), rawBody, signature);
  }
}
