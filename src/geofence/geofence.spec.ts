import {
  AreaShape,
  EXIT_MARGIN_METERS,
  containsPoint,
  distanceToEdgeMeters,
  polygonAreaSquareMeters,
  stepGeofence,
} from './geofence';

// A roughly 200 m square yard in Odesa, and a second one about 2 km east.
const YARD: AreaShape = {
  id: 'yard',
  points: [
    { lat: 46.46, lng: 30.54 },
    { lat: 46.46, lng: 30.5426 },
    { lat: 46.4618, lng: 30.5426 },
    { lat: 46.4618, lng: 30.54 },
  ],
};
const DACHA: AreaShape = {
  id: 'dacha',
  points: [
    { lat: 46.46, lng: 30.57 },
    { lat: 46.46, lng: 30.5726 },
    { lat: 46.4618, lng: 30.5726 },
    { lat: 46.4618, lng: 30.57 },
  ],
};

const IN_YARD = { lat: 46.4609, lng: 30.5413 };
const IN_DACHA = { lat: 46.4609, lng: 30.5713 };
/** ~10 m north of the yard's top edge: past it, but within GPS wobble. */
const JUST_PAST_YARD = { lat: 46.46189, lng: 30.5413 };
/** ~500 m north of the yard. */
const FAR_AWAY = { lat: 46.4663, lng: 30.5413 };

describe('geometry', () => {
  it('knows inside from outside', () => {
    expect(containsPoint(YARD.points, IN_YARD)).toBe(true);
    expect(containsPoint(YARD.points, FAR_AWAY)).toBe(false);
    expect(containsPoint(YARD.points, JUST_PAST_YARD)).toBe(false);
  });

  it('handles a concave outline', () => {
    // An L: the notch at the top right is outside.
    const ell = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.002 },
      { lat: 0.001, lng: 0.002 },
      { lat: 0.001, lng: 0.001 },
      { lat: 0.002, lng: 0.001 },
      { lat: 0.002, lng: 0 },
    ];
    expect(containsPoint(ell, { lat: 0.0005, lng: 0.0015 })).toBe(true);
    expect(containsPoint(ell, { lat: 0.0015, lng: 0.0015 })).toBe(false);
  });

  it('measures the distance to the nearest edge', () => {
    const meters = distanceToEdgeMeters(YARD.points, FAR_AWAY);
    expect(meters).toBeGreaterThan(490);
    expect(meters).toBeLessThan(510);
    expect(distanceToEdgeMeters(YARD.points, JUST_PAST_YARD)).toBeLessThan(
      EXIT_MARGIN_METERS,
    );
  });

  it('measures area, and none for a line', () => {
    const yard = polygonAreaSquareMeters(YARD.points);
    // 200 m × 200 m, give or take the projection.
    expect(yard).toBeGreaterThan(38_000);
    expect(yard).toBeLessThan(42_000);
    expect(
      polygonAreaSquareMeters([
        { lat: 46.46, lng: 30.54 },
        { lat: 46.461, lng: 30.54 },
        { lat: 46.462, lng: 30.54 },
      ]),
    ).toBeCloseTo(0);
  });
});

describe('stepGeofence', () => {
  const inYard = { inside: true, areaId: 'yard' } as const;
  const outside = { inside: false, areaId: null } as const;

  it('reports the fix that leaves', () => {
    const step = stepGeofence({
      state: inYard,
      areas: [YARD],
      point: FAR_AWAY,
    });
    expect(step.left?.id).toBe('yard');
    expect(step.state).toEqual(outside);
  });

  it('reports it once, not on every fix outside', () => {
    const step = stepGeofence({
      state: outside,
      areas: [YARD],
      point: FAR_AWAY,
    });
    expect(step.left).toBeNull();
    expect(step.state).toEqual(outside);
  });

  it('re-arms once the tracker is back inside', () => {
    const back = stepGeofence({
      state: outside,
      areas: [YARD],
      point: IN_YARD,
    });
    expect(back).toEqual({ state: inYard, left: null });
    const outAgain = stepGeofence({
      state: back.state,
      areas: [YARD],
      point: FAR_AWAY,
    });
    expect(outAgain.left?.id).toBe('yard');
  });

  it('does not treat GPS wobble at the fence as an exit', () => {
    const step = stepGeofence({
      state: inYard,
      areas: [YARD],
      point: JUST_PAST_YARD,
    });
    expect(step).toEqual({ state: inYard, left: null });
  });

  it('says nothing about a tracker that was already out when the area was drawn', () => {
    const step = stepGeofence({ state: null, areas: [YARD], point: FAR_AWAY });
    expect(step.left).toBeNull();
    expect(step.state).toEqual(outside);
  });

  it('does not guess from a first fix at the fence', () => {
    const step = stepGeofence({
      state: null,
      areas: [YARD],
      point: JUST_PAST_YARD,
    });
    expect(step).toEqual({ state: null, left: null });
  });

  it('counts any area as safe', () => {
    // Walking from the yard to the dacha passes nowhere worth a push once it
    // arrives — but the stretch between them is outside both.
    const atDacha = stepGeofence({
      state: inYard,
      areas: [YARD, DACHA],
      point: IN_DACHA,
    });
    expect(atDacha).toEqual({
      state: { inside: true, areaId: 'dacha' },
      left: null,
    });
  });

  it('names the area it was last inside', () => {
    const step = stepGeofence({
      state: { inside: true, areaId: 'dacha' },
      areas: [YARD, DACHA],
      point: FAR_AWAY,
    });
    // FAR_AWAY is nearer the yard, but it was the dacha it walked out of.
    expect(step.left?.id).toBe('dacha');
  });

  it('forgets everything when there are no areas', () => {
    expect(stepGeofence({ state: inYard, areas: [], point: FAR_AWAY })).toEqual(
      { state: null, left: null },
    );
  });
});
