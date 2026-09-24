import { ApiError } from '../http/ApiError.js';
import { getDayRange, TIMEZONE } from './day.js';

const DAY_MS = 86_400_000;
const INDIA_OFFSET_MS = 19_800_000;
const dateString = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);
const utcStart = (timestamp) => new Date(timestamp - INDIA_OFFSET_MS).toISOString();

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, 'Use a date in YYYY-MM-DD format.', 'INVALID_REPORT_DATE');
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || dateString(timestamp) !== value || value < '0001-01-01') {
    throw new ApiError(400, 'Choose a valid calendar date.', 'INVALID_REPORT_DATE');
  }
  return timestamp;
}

function monthStart(timestamp, offset = 0) {
  const date = new Date(timestamp);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.getTime();
}

/** Calendar periods in India. UTC half-open bounds keep indexed SQL predicates simple. */
export function getPeriodRange({ period = 'day', date } = {}, now = new Date()) {
  if (!['day', 'week', 'month'].includes(period)) {
    throw new ApiError(400, 'Choose day, week, or month for the report.', 'INVALID_REPORT_PERIOD');
  }
  const today = getDayRange(now).date;
  const anchor = date ?? today;
  const anchorMs = parseDate(anchor);
  if (anchor > today) throw new ApiError(400, 'Reports are available through today.', 'FUTURE_REPORT_DATE');
  const todayMs = parseDate(today);
  let startMs = anchorMs;
  let endMs = anchorMs + DAY_MS;
  if (period === 'week') {
    const weekday = new Date(anchorMs).getUTCDay();
    startMs -= ((weekday + 6) % 7) * DAY_MS;
    endMs = startMs + 7 * DAY_MS;
  } else if (period === 'month') {
    startMs = monthStart(anchorMs);
    endMs = monthStart(anchorMs, 1);
  }
  const effectiveEndMs = Math.min(endMs, todayMs + DAY_MS);
  const daysElapsed = Math.round((effectiveEndMs - startMs) / DAY_MS);
  const previousStartMs = period === 'month' ? monthStart(startMs, -1) : startMs - (endMs - startMs);
  const previousDays = Math.round((startMs - previousStartMs) / DAY_MS);
  // A shorter previous month limits both sides to the same number of calendar days.
  const comparisonDays = Math.min(daysElapsed, previousDays);
  return {
    period, timezone: TIMEZONE, anchor_date: anchor,
    start_date: dateString(startMs), end_date: dateString(endMs - DAY_MS),
    start: utcStart(startMs), end: utcStart(effectiveEndMs), days_elapsed: daysElapsed,
    dates: Array.from({ length: daysElapsed }, (_, index) => dateString(startMs + index * DAY_MS)),
    comparison: {
      start_date: dateString(previousStartMs),
      end_date: dateString(previousStartMs + (comparisonDays - 1) * DAY_MS),
      start: utcStart(previousStartMs), end: utcStart(previousStartMs + comparisonDays * DAY_MS),
      current_end: utcStart(startMs + comparisonDays * DAY_MS), days_elapsed: comparisonDays,
    },
  };
}
