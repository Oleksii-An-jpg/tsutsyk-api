/**
 * The 27 oblast-level locations alerts.in.ua reports on, in the exact order
 * its IoT endpoint packs them.
 *
 * `GET /v1/iot/active_air_raid_alerts_by_oblast.json` answers with a single
 * 27-character string — one character per oblast, positional. There is no key
 * in the payload, so this order *is* the schema: shift it by one and every
 * tracker in the country is told about the wrong oblast. The order and the
 * uids below are transcribed from the official client
 * (github.com/alerts-ua/alerts-in-ua-py — `AirRaidAlertOblastStatuses.LOCATIONS`
 * and `LocationUidResolver`), not guessed, and `oblasts.spec.ts` pins them.
 *
 * We key our own storage by `uid` rather than by position, because the uid is
 * alerts.in.ua's stable identifier while the position is an artefact of the
 * wire format.
 */
export interface Oblast {
  /** Index into the IoT status string. */
  readonly index: number;
  /** alerts.in.ua's stable location uid. */
  readonly uid: number;
  /** Ukrainian title, as alerts.in.ua spells it. */
  readonly title: string;
}

export const OBLASTS: readonly Oblast[] = [
  { index: 0, uid: 29, title: 'Автономна Республіка Крим' },
  { index: 1, uid: 8, title: 'Волинська область' },
  { index: 2, uid: 4, title: 'Вінницька область' },
  { index: 3, uid: 9, title: 'Дніпропетровська область' },
  { index: 4, uid: 28, title: 'Донецька область' },
  { index: 5, uid: 10, title: 'Житомирська область' },
  { index: 6, uid: 11, title: 'Закарпатська область' },
  { index: 7, uid: 12, title: 'Запорізька область' },
  { index: 8, uid: 13, title: 'Івано-Франківська область' },
  { index: 9, uid: 31, title: 'м. Київ' },
  { index: 10, uid: 14, title: 'Київська область' },
  { index: 11, uid: 15, title: 'Кіровоградська область' },
  { index: 12, uid: 16, title: 'Луганська область' },
  { index: 13, uid: 27, title: 'Львівська область' },
  { index: 14, uid: 17, title: 'Миколаївська область' },
  { index: 15, uid: 18, title: 'Одеська область' },
  { index: 16, uid: 19, title: 'Полтавська область' },
  { index: 17, uid: 5, title: 'Рівненська область' },
  { index: 18, uid: 30, title: 'м. Севастополь' },
  { index: 19, uid: 20, title: 'Сумська область' },
  { index: 20, uid: 21, title: 'Тернопільська область' },
  { index: 21, uid: 22, title: 'Харківська область' },
  { index: 22, uid: 23, title: 'Херсонська область' },
  { index: 23, uid: 3, title: 'Хмельницька область' },
  { index: 24, uid: 24, title: 'Черкаська область' },
  { index: 25, uid: 26, title: 'Чернівецька область' },
  { index: 26, uid: 25, title: 'Чернігівська область' },
] as const;

/** How many characters a well-formed IoT status string carries. */
export const OBLAST_COUNT = OBLASTS.length;

const BY_UID = new Map(OBLASTS.map((oblast) => [oblast.uid, oblast]));

export function findOblast(uid: number): Oblast | undefined {
  return BY_UID.get(uid);
}

export function isKnownOblastUid(uid: number): boolean {
  return BY_UID.has(uid);
}
