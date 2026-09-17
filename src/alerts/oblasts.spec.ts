import { OBLASTS, OBLAST_COUNT, findOblast, isKnownOblastUid } from './oblasts';

// The IoT payload is positional and unlabelled, so these are not "just data":
// an off-by-one here silently points a tracker at another oblast's alerts.
describe('oblast table', () => {
  it('covers all 27 oblast-level locations', () => {
    expect(OBLAST_COUNT).toBe(27);
    expect(OBLASTS).toHaveLength(27);
  });

  it('indexes the status string contiguously from zero', () => {
    expect(OBLASTS.map((o) => o.index)).toEqual([...Array(27).keys()]);
  });

  it('has unique uids and titles', () => {
    expect(new Set(OBLASTS.map((o) => o.uid)).size).toBe(27);
    expect(new Set(OBLASTS.map((o) => o.title)).size).toBe(27);
  });

  // Spot-checks against the official client's own tables. These are the
  // positions most likely to rot: the two cities, which sort where a reader
  // would not expect, and the ends of the string.
  it.each([
    [0, 29, 'Автономна Республіка Крим'],
    [9, 31, 'м. Київ'],
    [18, 30, 'м. Севастополь'],
    [23, 3, 'Хмельницька область'],
    [26, 25, 'Чернігівська область'],
  ])('places index %i as uid %i (%s)', (index, uid, title) => {
    const oblast = OBLASTS[index];
    expect(oblast.uid).toBe(uid);
    expect(oblast.title).toBe(title);
  });

  it('looks oblasts up by uid', () => {
    expect(findOblast(31)?.title).toBe('м. Київ');
    expect(findOblast(9)?.title).toBe('Дніпропетровська область');
    expect(findOblast(9999)).toBeUndefined();
    expect(isKnownOblastUid(31)).toBe(true);
    // A raion uid is not an oblast uid, even though alerts.in.ua knows it.
    expect(isKnownOblastUid(78)).toBe(false);
  });
});
