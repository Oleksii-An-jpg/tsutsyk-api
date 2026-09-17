import {
  ALERT_INTERVAL_SECONDS,
  LOW_BATTERY_PERCENT,
  NORMAL_INTERVAL_SECONDS,
  resolveReportingPolicy,
} from './reporting-policy';

describe('resolveReportingPolicy', () => {
  it('runs at the everyday cadence when the oblast is quiet', () => {
    expect(resolveReportingPolicy({ alertStatus: 'no_alert' })).toEqual({
      intervalSeconds: NORMAL_INTERVAL_SECONDS,
      reason: 'normal',
    });
  });

  it.each(['active', 'partly'] as const)(
    'accelerates on a %s alert',
    (alertStatus) => {
      expect(
        resolveReportingPolicy({ alertStatus, batteryPercent: 80 }),
      ).toEqual({
        intervalSeconds: ALERT_INTERVAL_SECONDS,
        reason: 'air_raid',
      });
    },
  );

  // The whole point of the `unknown` status: an alerts.in.ua outage must not
  // read as an alert and put every tracker in the country on the fast cadence.
  it('does not accelerate on an unknown status', () => {
    expect(resolveReportingPolicy({ alertStatus: 'unknown' })).toEqual({
      intervalSeconds: NORMAL_INTERVAL_SECONDS,
      reason: 'normal',
    });
  });

  it('holds the everyday cadence on a low battery, alert or not', () => {
    expect(
      resolveReportingPolicy({
        alertStatus: 'active',
        batteryPercent: LOW_BATTERY_PERCENT - 1,
      }),
    ).toEqual({
      intervalSeconds: NORMAL_INTERVAL_SECONDS,
      reason: 'low_battery',
    });
  });

  it('accelerates right at the battery floor, not below it', () => {
    expect(
      resolveReportingPolicy({
        alertStatus: 'active',
        batteryPercent: LOW_BATTERY_PERCENT,
      }).reason,
    ).toBe('air_raid');
  });

  // A missing reading is not a low reading. The alert is certain; the flat
  // battery is only a guess, so the feature stays on.
  it.each([[null], [undefined]] as Array<[number | null | undefined]>)(
    'accelerates when the battery reads %s',
    (batteryPercent) => {
      expect(
        resolveReportingPolicy({ alertStatus: 'active', batteryPercent }),
      ).toEqual({
        intervalSeconds: ALERT_INTERVAL_SECONDS,
        reason: 'air_raid',
      });
    },
  );
});
