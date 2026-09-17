import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TrackerController } from './tracker.controller';
import { TrackerService } from './tracker.service';
import {
  ALERT_INTERVAL_SECONDS,
  NORMAL_INTERVAL_SECONDS,
} from './reporting-policy';

// The downlink is a contract with firmware we cannot redeploy. These tests
// pin the shape of the answer as much as the behaviour.
describe('TrackerController', () => {
  let recordSingleLocation: jest.Mock;
  let resolveReportingPolicyFor: jest.Mock;
  let controller: TrackerController;

  const validBody = {
    sessionId: 'walk-1',
    lat: 50.4501,
    lng: 30.5234,
    battery: 82,
  };

  beforeEach(() => {
    recordSingleLocation = jest.fn().mockResolvedValue({ id: 'loc-1' });
    resolveReportingPolicyFor = jest.fn().mockResolvedValue({
      policy: { intervalSeconds: NORMAL_INTERVAL_SECONDS, reason: 'normal' },
      alertStatus: 'no_alert',
    });
    controller = new TrackerController({
      recordSingleLocation,
      resolveReportingPolicyFor,
    } as unknown as TrackerService);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('acknowledges the fix and returns the cadence with it', async () => {
    resolveReportingPolicyFor.mockResolvedValue({
      policy: { intervalSeconds: ALERT_INTERVAL_SECONDS, reason: 'air_raid' },
      alertStatus: 'active',
    });

    await expect(controller.postLocation('abc123', validBody)).resolves.toEqual(
      {
        locationId: 'loc-1',
        reporting: {
          intervalSeconds: ALERT_INTERVAL_SECONDS,
          reason: 'air_raid',
        },
        airRaid: 'active',
      },
    );

    expect(recordSingleLocation).toHaveBeenCalledWith({
      tsutsykId: 'abc123',
      sessionId: 'walk-1',
      lat: 50.4501,
      lng: 30.5234,
      battery: 82,
    });
  });

  it('feeds the reported battery into the policy', async () => {
    await controller.postLocation('abc123', { ...validBody, battery: 9 });
    expect(resolveReportingPolicyFor).toHaveBeenCalledWith('abc123', 9);
  });

  it('reports a missing battery as null rather than inventing one', async () => {
    await controller.postLocation('abc123', {
      sessionId: validBody.sessionId,
      lat: validBody.lat,
      lng: validBody.lng,
    });
    expect(resolveReportingPolicyFor).toHaveBeenCalledWith('abc123', null);
    expect(recordSingleLocation).toHaveBeenCalledWith(
      expect.objectContaining({ battery: undefined }),
    );
  });

  it('accepts a battery of exactly 0', async () => {
    await controller.postLocation('abc123', { ...validBody, battery: 0 });
    expect(resolveReportingPolicyFor).toHaveBeenCalledWith('abc123', 0);
  });

  describe('rejects a body it cannot trust', () => {
    it.each([
      ['no sessionId', { lat: 50, lng: 30 }],
      ['a blank sessionId', { sessionId: '   ', lat: 50, lng: 30 }],
      ['a non-string sessionId', { sessionId: 7, lat: 50, lng: 30 }],
      ['no lat', { sessionId: 's', lng: 30 }],
      ['a string lat', { sessionId: 's', lat: '50', lng: 30 }],
      ['NaN lat', { sessionId: 's', lat: NaN, lng: 30 }],
      ['an out-of-range lat', { sessionId: 's', lat: 91, lng: 30 }],
      ['an out-of-range lng', { sessionId: 's', lat: 50, lng: 181 }],
      [
        'a battery over 100',
        { sessionId: 's', lat: 50, lng: 30, battery: 101 },
      ],
      ['a negative battery', { sessionId: 's', lat: 50, lng: 30, battery: -1 }],
      ['a string battery', { sessionId: 's', lat: 50, lng: 30, battery: '80' }],
    ])('%s', async (_label, body) => {
      await expect(controller.postLocation('abc123', body)).rejects.toThrow();
      expect(recordSingleLocation).not.toHaveBeenCalled();
    });
  });

  it('answers 503 on a storage failure so the device retries the fix', async () => {
    recordSingleLocation.mockRejectedValue(new Error('firestore is down'));

    await expect(controller.postLocation('abc123', validBody)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  // A session belonging to another tracker is the device's mistake; hiding it
  // behind a 503 would have it retry forever.
  it('lets a client error speak for itself', async () => {
    recordSingleLocation.mockRejectedValue(
      new ConflictException('session belongs to another Tsutsyk'),
    );

    await expect(controller.postLocation('abc123', validBody)).rejects.toThrow(
      ConflictException,
    );
  });
});
