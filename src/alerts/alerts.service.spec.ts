import { Logger } from '@nestjs/common';
import { AlertsService, parseOblastStatuses } from './alerts.service';
import { OBLASTS, OBLAST_COUNT } from './oblasts';

// ─── helpers ────────────────────────────────────────────────────────────

/** A well-formed IoT status string with the named oblast uids set. */
function statusString(overrides: Record<number, 'A' | 'P' | 'N'> = {}): string {
  const chars = Array<string>(OBLAST_COUNT).fill('N');
  for (const [uid, char] of Object.entries(overrides)) {
    const oblast = OBLASTS.find((o) => o.uid === Number(uid));
    if (!oblast) throw new Error(`test used an unknown oblast uid ${uid}`);
    chars[oblast.index] = char;
  }
  return chars.join('');
}

function response({
  status = 200,
  body,
  lastModified,
}: {
  status?: number;
  body?: unknown;
  lastModified?: string;
}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    headers: {
      get: (name: string) =>
        name === 'Last-Modified' ? (lastModified ?? null) : null,
    },
  } as unknown as Response;
}

const KYIV = 31;
const LVIV = 27;

describe('parseOblastStatuses', () => {
  it('maps every oblast by uid', () => {
    const statuses = parseOblastStatuses(
      statusString({ [KYIV]: 'A', [LVIV]: 'P' }),
    );
    expect(statuses.size).toBe(OBLAST_COUNT);
    expect(statuses.get(KYIV)).toBe('active');
    expect(statuses.get(LVIV)).toBe('partly');
    expect(statuses.get(9)).toBe('no_alert');
  });

  it('reads an unassigned slot as unknown, not as quiet', () => {
    const chars = statusString().split('');
    chars[OBLASTS.find((o) => o.uid === KYIV).index] = ' ';
    expect(parseOblastStatuses(chars.join('')).get(KYIV)).toBe('unknown');
  });

  // A short string would map the tail of the alphabet to "no alert" — the one
  // failure this feature must never have — so it is an error, not a warning.
  it.each([
    ['too short', 'NNN'],
    ['empty', ''],
  ])('rejects a %s payload', (_label, body) => {
    expect(() => parseOblastStatuses(body)).toThrow(/expected 27 oblast/);
  });

  // The official client reads only the first 27 positions; anything past them
  // is not ours to judge, and rejecting it left every oblast on "unknown".
  it('reads the leading oblasts of a longer payload', () => {
    const body = statusString({ [KYIV]: 'A' }) + 'NNNNA ';
    const statuses = parseOblastStatuses(body);
    expect(statuses.size).toBe(OBLAST_COUNT);
    expect(statuses.get(KYIV)).toBe('active');
    expect(statuses.get(LVIV)).toBe('no_alert');
  });

  it('reads an unrecognised status character as unknown for that oblast only', () => {
    const chars = statusString().split('');
    chars[0] = 'X';
    const statuses = parseOblastStatuses(chars.join(''));
    expect(statuses.get(OBLASTS[0].uid)).toBe('unknown');
    expect(statuses.get(LVIV)).toBe('no_alert');
  });

  it.each([[null], [42], [{}], [undefined]])(
    'rejects a non-string payload (%p)',
    (body) => {
      expect(() => parseOblastStatuses(body)).toThrow(
        /expected a status string/,
      );
    },
  );
});

describe('AlertsService', () => {
  const originalEnv = process.env;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv, ALERTS_IN_UA_TOKEN: 'test-token' };
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    // The service logs every upstream failure on purpose; the failure paths
    // below would otherwise bury the test output in expected noise.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('without a token', () => {
    beforeEach(() => {
      delete process.env.ALERTS_IN_UA_TOKEN;
    });

    it('stands down and answers unknown for everything', async () => {
      const service = new AlertsService();
      expect(service.enabled).toBe(false);

      await service.poll();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(service.getStatus(KYIV)).toBe('unknown');
      expect(service.isAlerted(KYIV)).toBe(false);
    });

    it('starts no timer', () => {
      const service = new AlertsService();
      service.onModuleInit();
      expect(fetchMock).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });
  });

  it('records the statuses from a successful poll', async () => {
    fetchMock.mockResolvedValue(
      response({ body: statusString({ [KYIV]: 'A', [LVIV]: 'P' }) }),
    );
    const service = new AlertsService();

    await service.poll();

    expect(service.getStatus(KYIV)).toBe('active');
    expect(service.getStatus(LVIV)).toBe('partly');
    expect(service.getStatus(9)).toBe('no_alert');
    expect(service.isAlerted(KYIV)).toBe(true);
    expect(service.isAlerted(9)).toBe(false);
  });

  it('authenticates the way alerts.in.ua expects', async () => {
    fetchMock.mockResolvedValue(response({ body: statusString() }));

    await new AlertsService().poll();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.alerts.in.ua/v1/iot/active_air_raid_alerts_by_oblast.json',
    );
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer test-token',
    });
  });

  it('revalidates with If-Modified-Since once it has a Last-Modified', async () => {
    fetchMock.mockResolvedValueOnce(
      response({
        body: statusString(),
        lastModified: 'Wed, 17 Sep 2026 10:00:00 GMT',
      }),
    );
    fetchMock.mockResolvedValueOnce(response({ status: 304 }));
    const service = new AlertsService();

    await service.poll();
    await service.poll();

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      'If-Modified-Since': 'Wed, 17 Sep 2026 10:00:00 GMT',
    });
  });

  // A 304 is not "no news" — it is the feed confirming the reading is current,
  // which is exactly what the staleness clock needs to hear. Without this the
  // status would age out while the feed was busy telling us it had not changed.
  it('treats a 304 as a fresh confirmation', async () => {
    const t0 = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    fetchMock.mockResolvedValueOnce(
      response({ body: statusString({ [KYIV]: 'A' }) }),
    );
    const service = new AlertsService();
    await service.poll(t0);
    expect(service.getSnapshotAge(t0)).toBe(0);

    // Five minutes on, the original reading is well past the freshness window.
    const later = t0 + 300_000;
    nowSpy.mockReturnValue(later);
    fetchMock.mockResolvedValueOnce(response({ status: 304 }));
    await service.poll(later);

    expect(service.getSnapshotAge(later)).toBe(0);
    expect(service.getStatus(KYIV, later)).toBe('active');
    // And it is genuinely fresh, not merely held: a quiet oblast in the same
    // snapshot reads as quiet rather than decaying to unknown.
    expect(service.getStatus(9, later)).toBe('no_alert');
  });

  describe('when the feed goes away', () => {
    const STALE = 180_000;
    const HOLD = 600_000;

    it('stops vouching for a quiet oblast once the reading is stale', async () => {
      fetchMock.mockResolvedValue(response({ body: statusString() }));
      const service = new AlertsService();
      await service.poll();
      const now = Date.now();

      expect(service.getStatus(9, now + STALE - 1)).toBe('no_alert');
      expect(service.getStatus(9, now + STALE + 1)).toBe('unknown');
    });

    // The asymmetry that matters: losing the feed mid-alert must not quietly
    // withdraw the feature during the emergency it exists for.
    it('holds a raised alert past the freshness window', async () => {
      fetchMock.mockResolvedValue(
        response({ body: statusString({ [KYIV]: 'A' }) }),
      );
      const service = new AlertsService();
      await service.poll();
      const now = Date.now();

      expect(service.getStatus(KYIV, now + STALE + 1)).toBe('active');
      expect(service.isAlerted(KYIV, now + HOLD - 1)).toBe(true);
      expect(service.getStatus(KYIV, now + HOLD + 1)).toBe('unknown');
    });

    it('keeps the last good snapshot when a poll fails', async () => {
      fetchMock.mockResolvedValueOnce(
        response({ body: statusString({ [KYIV]: 'A' }) }),
      );
      const service = new AlertsService();
      await service.poll();

      fetchMock.mockRejectedValueOnce(new Error('network down'));
      await expect(service.poll()).resolves.toBeUndefined();

      expect(service.getStatus(KYIV)).toBe('active');
    });

    it('keeps the last good snapshot when the payload is malformed', async () => {
      fetchMock.mockResolvedValueOnce(
        response({ body: statusString({ [KYIV]: 'A' }) }),
      );
      const service = new AlertsService();
      await service.poll();

      fetchMock.mockResolvedValueOnce(response({ body: 'garbage' }));
      await service.poll();

      expect(service.getStatus(KYIV)).toBe('active');
    });

    it('backs off after a 429 instead of hammering the feed', async () => {
      fetchMock.mockResolvedValueOnce(response({ status: 429 }));
      const service = new AlertsService();

      await service.poll();
      await service.poll();
      await service.poll();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403, 500])('survives a %i', async (status) => {
      fetchMock.mockResolvedValue(response({ status }));
      const service = new AlertsService();

      await expect(service.poll()).resolves.toBeUndefined();
      expect(service.getStatus(KYIV)).toBe('unknown');
    });
  });

  describe('transitions', () => {
    /** Polls once per status string and collects everything emitted. */
    async function drive(...strings: string[]) {
      const service = new AlertsService();
      const emitted: { uid: number; alerted: boolean; status: string }[] = [];
      service.onTransition((transitions) => {
        emitted.push(...transitions);
      });
      for (const body of strings) {
        fetchMock.mockResolvedValueOnce(response({ body }));
        await service.poll();
      }
      return { service, emitted };
    }

    // A restart during an alert must not re-announce it to a whole oblast.
    it('says nothing about the first reading of a process', async () => {
      const { emitted } = await drive(statusString({ [KYIV]: 'A' }));
      expect(emitted).toEqual([]);
    });

    it('reports an alert being raised', async () => {
      const { emitted } = await drive(
        statusString(),
        statusString({ [KYIV]: 'A' }),
      );
      expect(emitted).toEqual([{ uid: KYIV, status: 'active', alerted: true }]);
    });

    it('reports an alert being lifted', async () => {
      const { emitted } = await drive(
        statusString({ [KYIV]: 'A' }),
        statusString(),
      );
      expect(emitted).toEqual([
        { uid: KYIV, status: 'no_alert', alerted: false },
      ]);
    });

    // Both mean "there is an alert" — the owner has already been told.
    it('does not re-announce a partly alert over an active one', async () => {
      const { emitted } = await drive(
        statusString({ [KYIV]: 'A' }),
        statusString({ [KYIV]: 'P' }),
        statusString({ [KYIV]: 'A' }),
      );
      expect(emitted).toEqual([]);
    });

    it('reports each oblast that moved, and only those', async () => {
      const { emitted } = await drive(
        statusString({ [KYIV]: 'A' }),
        statusString({ [KYIV]: 'A', [LVIV]: 'P' }),
      );
      expect(emitted).toEqual([{ uid: LVIV, status: 'partly', alerted: true }]);
    });

    // An unreachable feed decays a reading to `unknown`, which is not an
    // all-clear. Announcing one would be the worst failure this module has.
    it('says nothing when the feed stops answering', async () => {
      const service = new AlertsService();
      const emitted: unknown[] = [];
      service.onTransition((transitions) => emitted.push(...transitions));

      fetchMock.mockResolvedValueOnce(
        response({ body: statusString({ [KYIV]: 'A' }) }),
      );
      await service.poll();
      fetchMock.mockResolvedValueOnce(
        response({ body: statusString({ [KYIV]: 'A', [LVIV]: 'A' }) }),
      );
      await service.poll();
      emitted.length = 0;

      fetchMock.mockRejectedValueOnce(new Error('network down'));
      await service.poll();
      fetchMock.mockResolvedValueOnce(response({ status: 500 }));
      await service.poll();

      expect(emitted).toEqual([]);
    });

    // A 304 is "still current", not a new reading, so nothing has moved.
    it('says nothing on a 304', async () => {
      const service = new AlertsService();
      const emitted: unknown[] = [];
      fetchMock.mockResolvedValueOnce(
        response({ body: statusString({ [KYIV]: 'A' }) }),
      );
      await service.poll();
      service.onTransition((transitions) => emitted.push(...transitions));

      fetchMock.mockResolvedValueOnce(response({ status: 304 }));
      await service.poll();

      expect(emitted).toEqual([]);
    });

    it('keeps polling when a listener throws', async () => {
      const service = new AlertsService();
      service.onTransition(() => {
        throw new Error('listener exploded');
      });

      fetchMock.mockResolvedValueOnce(response({ body: statusString() }));
      await service.poll();
      fetchMock.mockResolvedValueOnce(
        response({ body: statusString({ [KYIV]: 'A' }) }),
      );

      await expect(service.poll()).resolves.toBeUndefined();
      expect(service.getStatus(KYIV)).toBe('active');
    });

    it('stops telling a listener that unsubscribed', async () => {
      const service = new AlertsService();
      const emitted: unknown[] = [];
      const off = service.onTransition((t) => emitted.push(...t));

      fetchMock.mockResolvedValueOnce(response({ body: statusString() }));
      await service.poll();
      off();
      fetchMock.mockResolvedValueOnce(
        response({ body: statusString({ [KYIV]: 'A' }) }),
      );
      await service.poll();

      expect(emitted).toEqual([]);
    });
  });

  it('answers unknown for a uid that is not an oblast', async () => {
    fetchMock.mockResolvedValue(response({ body: statusString() }));
    const service = new AlertsService();
    await service.poll();

    expect(service.getStatus(78)).toBe('unknown');
    expect(service.getStatus(null)).toBe('unknown');
    expect(service.getStatus(undefined)).toBe('unknown');
  });
});
