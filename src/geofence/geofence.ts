/** A vertex, in the same degrees the tracker reports. */
export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/** Just the part of an alert area the exit check needs. */
export interface AreaShape {
  readonly id: string;
  readonly points: readonly LatLng[];
}

/**
 * What we last concluded about where a tracker is, relative to its areas.
 *
 * Null is "we do not know yet": no fix since the areas were last changed. It
 * is a real state, not a missing one — a tracker that is already outside when
 * its owner draws the first area has not *left* anything, and must not be
 * reported as if it had.
 */
export type GeofenceState = {
  readonly inside: boolean;
  /** Which area the last inside fix fell in, so an exit can name it. */
  readonly areaId: string | null;
} | null;

/**
 * How far past an area's edge a fix has to land before it counts as out.
 *
 * A phone-grade GPS fix wanders by 5–20 m standing still, and a dog asleep by
 * the fence would otherwise leave and re-enter every few reports — one push
 * per wobble. Between the edge and this margin the fix is ambiguous and the
 * state simply stays what it was, which is what makes this hysteresis rather
 * than a fatter polygon.
 */
export const EXIT_MARGIN_METERS = 25;

/** The limits an area is held to when it is saved. */
export const MIN_AREA_POINTS = 3;
export const MAX_AREA_POINTS = 100;
export const MAX_AREAS_PER_TRACKER = 10;
export const MAX_AREA_NAME_LENGTH = 40;
/**
 * Smaller than a room. Mostly catches three taps on the same spot, or a line
 * — shapes that would put a tracker "outside" on every single fix.
 */
export const MIN_AREA_SQUARE_METERS = 25;

const EARTH_RADIUS_METERS = 6371e3;
const RAD = Math.PI / 180;

/**
 * Projects onto a flat plane in metres, centred on `origin`.
 *
 * An equirectangular projection is plenty at the scale of a yard or a
 * neighbourhood, and it keeps every distance below a plain Euclidean one.
 * It does not handle the antimeridian, which nobody walks a dog across.
 */
function project(origin: LatLng, point: LatLng): [number, number] {
  const x =
    (point.lng - origin.lng) *
    RAD *
    Math.cos(origin.lat * RAD) *
    EARTH_RADIUS_METERS;
  const y = (point.lat - origin.lat) * RAD * EARTH_RADIUS_METERS;
  return [x, y];
}

/** Ray casting, with the fix itself as the origin of the plane. */
export function containsPoint(
  polygon: readonly LatLng[],
  point: LatLng,
): boolean {
  let inside = false;
  const ring = polygon.map((vertex) => project(point, vertex));
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** How far the fix is from the nearest point on the polygon's outline. */
export function distanceToEdgeMeters(
  polygon: readonly LatLng[],
  point: LatLng,
): number {
  const ring = polygon.map((vertex) => project(point, vertex));
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    best = Math.min(best, distanceToSegment(ring[j], ring[i]));
  }
  return best;
}

/** Distance from the origin to the segment a–b. */
function distanceToSegment(
  [ax, ay]: [number, number],
  [bx, by]: [number, number],
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, (-ax * dx + -ay * dy) / lengthSquared));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Shoelace, on the same flat projection. */
export function polygonAreaSquareMeters(polygon: readonly LatLng[]): number {
  if (polygon.length < 3) return 0;
  const ring = polygon.map((vertex) => project(polygon[0], vertex));
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(twice) / 2;
}

export interface GeofenceStep<A extends AreaShape> {
  /** What to remember for the next fix. */
  readonly state: GeofenceState;
  /** The area the tracker has just left, when this fix is the one that left. */
  readonly left: A | null;
}

/**
 * Decides what one fix means for one tracker.
 *
 * The areas are taken together: inside any of them is inside. Otherwise a dog
 * with a "home" and a "dacha" would be reported as escaped from one of them
 * the whole time it was safely in the other. Only the edge from inside to
 * clearly outside is reported, so a tracker that stays out is one push, not
 * one every five minutes.
 *
 * Pure and total, so every case can be pinned down without a database.
 */
export function stepGeofence<A extends AreaShape>({
  state,
  areas,
  point,
}: {
  state: GeofenceState;
  areas: readonly A[];
  point: LatLng;
}): GeofenceStep<A> {
  if (areas.length === 0) return { state: null, left: null };

  const containing = areas.find((area) => containsPoint(area.points, point));
  if (containing) {
    return { state: { inside: true, areaId: containing.id }, left: null };
  }

  const nearest = areas
    .map((area) => ({ area, meters: distanceToEdgeMeters(area.points, point) }))
    .reduce((a, b) => (b.meters < a.meters ? b : a));

  // Just past an edge: could be the dog, could be the GPS. Keep believing
  // whatever we believed, including "we do not know".
  if (nearest.meters <= EXIT_MARGIN_METERS) {
    return { state, left: null };
  }

  const outside: GeofenceState = { inside: false, areaId: null };
  if (!state?.inside) return { state: outside, left: null };

  const left = areas.find((area) => area.id === state.areaId) ?? nearest.area;
  return { state: outside, left };
}
