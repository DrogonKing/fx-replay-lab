/**
 * The timezone list, as cities.
 *
 * TradingView's picker shows city names with a UTC offset beside each one, because a city is
 * what a trader actually thinks in ("New York close", not "America/New_York"). This module
 * provides that list.
 *
 * Two things it deliberately does NOT do:
 *
 * 1. It does not store offsets. An offset is a function of the zone AND the moment — New York is
 *    UTC-4 in July and UTC-5 in January — so a hardcoded list is wrong for half the year, and
 *    wrong again for every DST rule change. Offsets are computed from Intl at the requested
 *    instant.
 * 2. It does not fetch anything. The app is offline-first, so the list is compiled in and the
 *    offsets come from the platform's IANA database. Nothing here touches the network.
 *
 * The zones are IANA identifiers, chosen so that a city maps to the zone its exchanges use.
 */

export interface TimezoneCity {
  /** display name, e.g. "New York" */
  city: string;
  /** IANA zone, e.g. "America/New_York" */
  zone: string;
  /** coarse grouping, used for the picker's sections */
  region: Region;
  /** true for a zone that is a forex/market centre, which the picker can mark */
  market?: boolean;
}

export type Region = "Americas" | "Europe" | "Africa" | "Middle East" | "Asia" | "Pacific";

/**
 * The list.
 *
 * Every entry was chosen because a market or a broker lives there, not to be exhaustive: a
 * thousand obscure zones make the picker worse at its job, which is finding your own zone fast.
 * Market centres are flagged so the picker can put them first.
 */
export const TIMEZONE_CITIES: TimezoneCity[] = [
  // ---------------------------------------------------------------- Americas
  { city: "Honolulu", zone: "Pacific/Honolulu", region: "Pacific" },
  { city: "Anchorage", zone: "America/Anchorage", region: "Americas" },
  { city: "Vancouver", zone: "America/Vancouver", region: "Americas" },
  { city: "Los Angeles", zone: "America/Los_Angeles", region: "Americas", market: true },
  { city: "Chicago", zone: "America/Chicago", region: "Americas", market: true },
  { city: "Mexico City", zone: "America/Mexico_City", region: "Americas" },
  { city: "Toronto", zone: "America/Toronto", region: "Americas" },
  { city: "New York", zone: "America/New_York", region: "Americas", market: true },
  { city: "Bogotá", zone: "America/Bogota", region: "Americas" },
  { city: "Lima", zone: "America/Lima", region: "Americas" },
  { city: "Santiago", zone: "America/Santiago", region: "Americas" },
  { city: "São Paulo", zone: "America/Sao_Paulo", region: "Americas", market: true },
  { city: "Buenos Aires", zone: "America/Argentina/Buenos_Aires", region: "Americas" },

  // ---------------------------------------------------------------- Europe
  { city: "Reykjavik", zone: "Atlantic/Reykjavik", region: "Europe" },
  { city: "Lisbon", zone: "Europe/Lisbon", region: "Europe" },
  { city: "Dublin", zone: "Europe/Dublin", region: "Europe" },
  { city: "London", zone: "Europe/London", region: "Europe", market: true },
  { city: "Madrid", zone: "Europe/Madrid", region: "Europe" },
  { city: "Paris", zone: "Europe/Paris", region: "Europe" },
  { city: "Amsterdam", zone: "Europe/Amsterdam", region: "Europe" },
  { city: "Brussels", zone: "Europe/Brussels", region: "Europe" },
  { city: "Frankfurt", zone: "Europe/Berlin", region: "Europe", market: true },
  { city: "Zurich", zone: "Europe/Zurich", region: "Europe", market: true },
  { city: "Milan", zone: "Europe/Rome", region: "Europe" },
  { city: "Vienna", zone: "Europe/Vienna", region: "Europe" },
  { city: "Prague", zone: "Europe/Prague", region: "Europe" },
  { city: "Warsaw", zone: "Europe/Warsaw", region: "Europe" },
  { city: "Stockholm", zone: "Europe/Stockholm", region: "Europe" },
  { city: "Oslo", zone: "Europe/Oslo", region: "Europe" },
  { city: "Copenhagen", zone: "Europe/Copenhagen", region: "Europe" },
  { city: "Helsinki", zone: "Europe/Helsinki", region: "Europe" },
  { city: "Athens", zone: "Europe/Athens", region: "Europe" },
  { city: "Bucharest", zone: "Europe/Bucharest", region: "Europe" },
  { city: "Kyiv", zone: "Europe/Kyiv", region: "Europe" },
  { city: "Moscow", zone: "Europe/Moscow", region: "Europe" },
  { city: "Istanbul", zone: "Europe/Istanbul", region: "Europe", market: true },

  // ---------------------------------------------------------------- Africa
  { city: "Abidjan", zone: "Africa/Abidjan", region: "Africa" },
  { city: "Accra", zone: "Africa/Accra", region: "Africa" },
  { city: "Lagos", zone: "Africa/Lagos", region: "Africa" },
  { city: "Cairo", zone: "Africa/Cairo", region: "Africa" },
  { city: "Johannesburg", zone: "Africa/Johannesburg", region: "Africa", market: true },
  { city: "Nairobi", zone: "Africa/Nairobi", region: "Africa" },

  // ---------------------------------------------------------------- Middle East
  { city: "Tehran", zone: "Asia/Tehran", region: "Middle East", market: true },
  { city: "Dubai", zone: "Asia/Dubai", region: "Middle East", market: true },
  { city: "Riyadh", zone: "Asia/Riyadh", region: "Middle East" },
  { city: "Doha", zone: "Asia/Qatar", region: "Middle East" },
  { city: "Kuwait City", zone: "Asia/Kuwait", region: "Middle East" },
  { city: "Baghdad", zone: "Asia/Baghdad", region: "Middle East" },
  { city: "Beirut", zone: "Asia/Beirut", region: "Middle East" },

  // ---------------------------------------------------------------- Asia
  { city: "Karachi", zone: "Asia/Karachi", region: "Asia" },
  { city: "Mumbai", zone: "Asia/Kolkata", region: "Asia", market: true },
  { city: "Kathmandu", zone: "Asia/Kathmandu", region: "Asia" },
  { city: "Dhaka", zone: "Asia/Dhaka", region: "Asia" },
  { city: "Bangkok", zone: "Asia/Bangkok", region: "Asia" },
  { city: "Jakarta", zone: "Asia/Jakarta", region: "Asia" },
  { city: "Kuala Lumpur", zone: "Asia/Kuala_Lumpur", region: "Asia" },
  { city: "Singapore", zone: "Asia/Singapore", region: "Asia", market: true },
  { city: "Hong Kong", zone: "Asia/Hong_Kong", region: "Asia", market: true },
  { city: "Shanghai", zone: "Asia/Shanghai", region: "Asia", market: true },
  { city: "Taipei", zone: "Asia/Taipei", region: "Asia" },
  { city: "Manila", zone: "Asia/Manila", region: "Asia" },
  { city: "Seoul", zone: "Asia/Seoul", region: "Asia" },
  { city: "Tokyo", zone: "Asia/Tokyo", region: "Asia", market: true },

  // ---------------------------------------------------------------- Pacific
  { city: "Perth", zone: "Australia/Perth", region: "Pacific" },
  { city: "Adelaide", zone: "Australia/Adelaide", region: "Pacific" },
  { city: "Sydney", zone: "Australia/Sydney", region: "Pacific", market: true },
  { city: "Brisbane", zone: "Australia/Brisbane", region: "Pacific" },
  // One entry only: Wellington and Auckland are the same IANA zone, and listing both would put
  // two identical choices in the picker. Named for the market centre, which is what gets looked
  // for during the Asian/Pacific session handover.
  { city: "Auckland", zone: "Pacific/Auckland", region: "Pacific", market: true },
];

/** UTC itself, which every list wants at the top and is not a city. */
export const UTC_ENTRY: TimezoneCity = { city: "UTC", zone: "UTC", region: "Europe" };

/**
 * Offset in seconds, computed by the platform's IANA database at a given instant.
 *
 * Implemented via a UTC round-trip rather than `timeZoneName: shortOffset` because shortOffset
 * returns a string like "GMT+4:30" that then has to be parsed back, and half-hour zones and the
 * sign convention make that a reliable source of bugs. This returns a number directly.
 */
export function cityOffsetSeconds(zone: string, epochSeconds: number): number {
  if (zone === "UTC" || zone === "Etc/UTC") return 0;
  const dt = new Date(epochSeconds * 1000);
  // Ask the zone what wall-clock time it is, then treat that as if it were UTC: the difference
  // is the offset. This is the same trick the core timezone module uses, kept local so this
  // module has no dependency on chart internals.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(dt);

  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  // some environments report hour 24 at midnight
  const hour = get("hour") === 24 ? 0 : get("hour");
  const asUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtcMs - dt.getTime()) / 1000);
}

/**
 * "UTC-4", "UTC+3:30", "UTC+0".
 *
 * Minutes matter: Tehran is +3:30, Kathmandu +5:45, Adelaide +9:30. Printing only whole hours
 * makes those zones look wrong, which is exactly the bug a trader would notice.
 */
export function offsetLabel(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? "-" : "+";
  const abs = Math.abs(offsetSeconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, "0")}`;
}

/**
 * Is the zone on daylight saving at this instant?
 *
 * Two earlier attempts were both wrong, and the way they failed is worth keeping:
 *
 *   1. `offset !== min(Jan, Jul)` — got the southern hemisphere backwards. Sydney's smaller
 *      offset is its JULY value, which is winter there, so July was reported as DST.
 *   2. taking the mode of twelve monthly samples — New York spends EIGHT months on DST, so the
 *      mode IS the DST offset and it reported standard time as DST.
 *
 * The platform already knows: `timeZoneName: "long"` returns "Eastern Daylight Time" or
 * "Eastern Standard Time". That is a direct answer with no hemisphere assumption and no
 * arithmetic. Some zones name it neither way ("Nepal Time", "Iran Standard Time") — those have
 * no DST, or abolished it, and "contains neither word" is the correct verdict for them.
 */
export function isDstAt(zone: string, epochSeconds: number): boolean {
  if (zone === "UTC" || zone === "Etc/UTC") return false;
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "long",
    })
      .formatToParts(new Date(epochSeconds * 1000))
      .find((p) => p.type === "timeZoneName")?.value ?? "";
    // "Daylight" appears in the DST name in every English locale Intl produces; "Summer" covers
    // the European style ("British Summer Time").
    return /daylight|summer/i.test(name);
  } catch {
    return false;
  }
}

export interface TimezoneOption {
  city: string;
  zone: string;
  region: Region;
  market: boolean;
  /** "UTC-4" at the reference instant */
  offset: string;
  /** raw seconds, for sorting */
  offsetSeconds: number;
  /** true when the zone is on daylight saving at the reference instant */
  dst: boolean;
  /** what to show in the picker: "New York" */
  label: string;
}

/**
 * The picker's list at a given instant.
 *
 * Sorted by offset then city, which is how the TradingView dialog reads: the zones are a clock,
 * so ordering them by time makes a range like "London through New York" visible at a glance.
 * Duplicate zones (Wellington and Auckland are the same zone) are collapsed so the list does not
 * offer two entries that do the same thing.
 */
export function timezoneOptions(referenceEpoch: number): TimezoneOption[] {
  const seen = new Set<string>();
  const out: TimezoneOption[] = [];

  const push = (c: TimezoneCity): void => {
    if (seen.has(c.zone)) return;
    seen.add(c.zone);
    const offsetSeconds = cityOffsetSeconds(c.zone, referenceEpoch);
    out.push({
      city: c.city,
      zone: c.zone,
      region: c.region,
      market: c.market === true,
      offset: offsetLabel(offsetSeconds),
      offsetSeconds,
      dst: isDstAt(c.zone, referenceEpoch),
      label: c.city,
    });
  };

  push(UTC_ENTRY);
  for (const c of TIMEZONE_CITIES) push(c);

  out.sort((a, b) => {
    if (a.offsetSeconds !== b.offsetSeconds) return a.offsetSeconds - b.offsetSeconds;
    return a.city.localeCompare(b.city);
  });
  return out;
}

/**
 * Filter for the search box.
 *
 * Matches the city, the IANA id, and the offset string — so typing "tehran", "asia/tehran" or
 * "+3:30" all work. Typing an offset is how someone finds their zone when they do not know which
 * city name the list uses.
 */
export function filterTimezones(options: TimezoneOption[], query: string): TimezoneOption[] {
  const q = query.trim().toLowerCase();
  if (q === "") return options;
  return options.filter((o) =>
    o.city.toLowerCase().includes(q) ||
    o.zone.toLowerCase().includes(q) ||
    o.offset.toLowerCase().includes(q) ||
    o.region.toLowerCase().includes(q),
  );
}

/**
 * The city for a zone, for the toolbar label. Falls back to the zone id.
 *
 * `_referenceEpoch` is unused: a city name does not vary with the instant, only the offset does.
 * Kept in the signature because callers that have the instant pass it, and a future zone whose
 * name changes over time (none today) would need it.
 */
export function cityForZone(zone: string, _referenceEpoch: number): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC";
  const hit = TIMEZONE_CITIES.find((c) => c.zone === zone);
  if (hit) return hit.city;
  // an unrecognised zone is still usable; show its own name rather than "unknown"
  const tail = zone.split("/").pop() ?? zone;
  return tail.replace(/_/g, " ");
}

/** "New York (UTC-4)" — what the toolbar button shows. */
export function zoneButtonLabel(zone: string, referenceEpoch: number): string {
  const city = cityForZone(zone, referenceEpoch);
  const off = offsetLabel(cityOffsetSeconds(zone, referenceEpoch));
  return `${city} (${off})`;
}
