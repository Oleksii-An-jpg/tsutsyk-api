import {
  ALERT_INTERVAL_SECONDS,
  LOW_BATTERY_PERCENT,
  NORMAL_INTERVAL_SECONDS,
  resolveReportingPolicy,
  batteryEdge,
  BATTERY_RECOVERED_PERCENT,
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

describe('batteryEdge', () => {
  it('warns the first time a battery goes low', () => {
    expect(
      batteryEdge({
        batteryPercent: LOW_BATTERY_PERCENT - 1,
        alreadyNotified: false,
      }),
    ).toBe('notify');
  });

  // The device reports every five minutes. Level-triggering this would be
  // twelve notifications an hour for as long as the battery stayed flat.
  it('says it once, not every fix', () => {
    expect(
      batteryEdge({
        batteryPercent: LOW_BATTERY_PERCENT - 1,
        alreadyNotified: true,
      }),
    ).toBe('none');
  });

  it('re-arms once the tracker has been charged', () => {
    expect(
      batteryEdge({
        batteryPercent: BATTERY_RECOVERED_PERCENT,
        alreadyNotified: true,
      }),
    ).toBe('clear');
  });

  // The gap between the two thresholds is the whole point: a reading wobbling
  // either side of 15% must not re-arm and re-fire all afternoon.
  it('does not re-arm in the gap between low and recovered', () => {
    for (
      let percent = LOW_BATTERY_PERCENT;
      percent < BATTERY_RECOVERED_PERCENT;
      percent++
    ) {
      expect(
        batteryEdge({ batteryPercent: percent, alreadyNotified: true }),
      ).toBe('none');
    }
  });

  it('warns only once across a run of jittery readings', () => {
    let notified = false;
    let warnings = 0;
    // A battery sitting on the threshold, as GPS-era hardware reports it.
    for (const percent of [16, 14, 15, 14, 16, 13, 15, 14]) {
      const edge = batteryEdge({
        batteryPercent: percent,
        alreadyNotified: notified,
      });
      if (edge === 'notify') {
        warnings++;
        notified = true;
      }
      if (edge === 'clear') notified = false;
    }
    expect(warnings).toBe(1);
  });

  it('warns again after a genuine charge and discharge', () => {
    let notified = false;
    let warnings = 0;
    for (const percent of [14, 10, 90, 40, 26, 14, 9]) {
      const edge = batteryEdge({
        batteryPercent: percent,
        alreadyNotified: notified,
      });
      if (edge === 'notify') {
        warnings++;
        notified = true;
      }
      if (edge === 'clear') notified = false;
    }
    expect(warnings).toBe(2);
  });

  // A fix without a battery reading is neither a recovery nor a warning, and
  // plenty of them arrive that way.
  it.each([[true], [false]])(
    'reads nothing into a missing battery (notified: %s)',
    (alreadyNotified) => {
      expect(batteryEdge({ batteryPercent: null, alreadyNotified })).toBe(
        'none',
      );
      expect(batteryEdge({ alreadyNotified })).toBe('none');
    },
  );

  it('treats the threshold itself as not yet low', () => {
    expect(
      batteryEdge({
        batteryPercent: LOW_BATTERY_PERCENT,
        alreadyNotified: false,
      }),
    ).toBe('none');
  });

  it('warns on a flat battery', () => {
    expect(batteryEdge({ batteryPercent: 0, alreadyNotified: false })).toBe(
      'notify',
    );
  });
});
