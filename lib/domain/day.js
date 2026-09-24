export const TIMEZONE = 'Asia/Kolkata';
const INDIA_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** India has a fixed UTC+05:30 offset. Persist UTC and query an indexed half-open UTC range. */
export function getDayRange(now = new Date()) {
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError('A valid date is required.');
  const date = new Date(timestamp + INDIA_OFFSET_MS).toISOString().slice(0, 10);
  const startMs = Date.parse(`${date}T00:00:00.000Z`) - INDIA_OFFSET_MS;
  return {
    date, timezone: TIMEZONE,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + DAY_MS).toISOString(),
  };
}

export function getIndiaHour(isoDate) {
  return new Date(new Date(isoDate).getTime() + INDIA_OFFSET_MS).getUTCHours();
}
