import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../http/ApiError.js';
import {
  DRAFT_LIFETIME_MS, LEAK_WARNING_COUNT, normalizeConfirmation, normalizeExpenseText,
  normalizeIdempotencyKey, publicDraft, publicExpense,
} from '../domain/expense.js';
import { getDayRange } from '../domain/day.js';
import { getPeriodRange } from '../domain/period.js';
import { requireUserScope } from '../db/ExpenseRepository.js';
import { parsingLimits } from '../domain/limits.js';

export class ExpenseService {
  constructor({ repository, parser, now = () => new Date(), limits }) {
    this.repository = repository;
    this.parser = parser;
    this.now = now;
    this.limits = parsingLimits(limits);
  }

  async preview(userId, input) {
    requireUserScope(userId);
    const text = normalizeExpenseText(input);
    await this.consumeParsingQuota(userId);
    const parsed = await this.parser.parse(text);
    const now = new Date(this.now());
    const draft = await this.repository.createDraft(userId, {
      ...parsed, id: randomUUID(), expires_at: new Date(now.getTime() + DRAFT_LIFETIME_MS).toISOString(),
    }, now.toISOString());
    return { draft: publicDraft(draft) };
  }

  async confirm(userId, input, inputKey) {
    requireUserScope(userId);
    const choices = normalizeConfirmation(input);
    const idempotencyKey = normalizeIdempotencyKey(inputKey);
    const requestHash = createHash('sha256').update(JSON.stringify(choices)).digest('hex');
    const now = new Date(this.now()).toISOString();
    const result = await this.repository.confirmDraft(userId, {
      ...choices, id: randomUUID(), created_at: now,
      idempotency_key: idempotencyKey, request_hash: requestHash,
    });
    if (result.expense) {
      if (!result.inserted) return this.replay(result.expense, requestHash);
      return { expense: publicExpense(result.expense), replayed: false };
    }
    const draft = await this.repository.findDraft(userId, choices.draft_id);
    if (!draft) throw new ApiError(404, 'This expense preview is unavailable. Please enter it again.', 'DRAFT_NOT_FOUND');
    if (draft.expires_at <= now) {
      throw new ApiError(410, 'This expense preview expired. Please enter it again.', 'DRAFT_EXPIRED');
    }
    throw new ApiError(409, 'This submission was already used for another expense or payment choice.', 'IDEMPOTENCY_CONFLICT');
  }

  async consumeParsingQuota(userId) {
    const quota = await this.repository.consumeParsingQuota(userId, this.now(), this.limits);
    if (!quota.allowed) {
      throw new ApiError(429, `Too many expense previews. Please try again in ${quota.retryAfterSeconds} seconds.`, 'RATE_LIMITED', {
        retry_after_seconds: quota.retryAfterSeconds,
      });
    }
  }

  // Kept for internal data import compatibility. HTTP creation requires preview + confirm.
  async create(userId, input, inputKey) {
    requireUserScope(userId);
    const text = normalizeExpenseText(input);
    const idempotencyKey = normalizeIdempotencyKey(inputKey);
    const requestHash = createHash('sha256').update(text).digest('hex');
    const existing = await this.repository.findByIdempotencyKey(userId, idempotencyKey);
    if (existing) return this.replay(existing, requestHash);

    await this.consumeParsingQuota(userId);
    const parsed = await this.parser.parse(text);
    const result = await this.repository.create(userId, {
      id: randomUUID(),
      item: parsed.item,
      amount_paise: parsed.amount_paise,
      category: parsed.category,
      is_potential_leak: parsed.is_potential_leak,
      created_at: new Date(this.now()).toISOString(),
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
    });
    if (!result.inserted) return this.replay(result.expense, requestHash);
    return { expense: publicExpense(result.expense), replayed: false };
  }

  replay(expense, requestHash) {
    if (!expense || expense.request_hash !== requestHash) {
      throw new ApiError(409, 'This submission key was already used for a different expense.', 'IDEMPOTENCY_CONFLICT');
    }
    return { expense: publicExpense(expense), replayed: true };
  }

  async listToday(userId) {
    requireUserScope(userId);
    const { date, timezone, start, end } = getDayRange(this.now());
    const expenses = await this.repository.listBetween(userId, start, end);
    return { date, timezone, expenses: expenses.map(publicExpense) };
  }

  async analyticsToday(userId) {
    requireUserScope(userId);
    const { date, timezone, start, end } = getDayRange(this.now());
    const { groups, hourly } = await this.repository.aggregateBetween(userId, start, end);
    const totalPaise = groups.reduce((sum, group) => sum + group.total_paise, 0);
    const leakPaise = groups.reduce((sum, group) => sum + group.leak_total_paise, 0);
    const hourlyByHour = new Map(hourly.map((entry) => [entry.hour, entry]));
    return {
      date, timezone, currency: 'INR',
      total_spent: totalPaise / 100,
      expense_count: groups.reduce((sum, group) => sum + group.count, 0),
      // INR per current calendar day, accumulated so far; never an extrapolated forecast.
      daily_leak_velocity: leakPaise / 100,
      leak_count: groups.reduce((sum, group) => sum + group.leak_count, 0),
      leak_share_percent: totalPaise ? Math.round(leakPaise / totalPaise * 10_000) / 100 : 0,
      small_transaction_count: groups.reduce((sum, group) => sum + group.small_transaction_count, 0),
      groups: groups.map((group) => ({
        category: group.category,
        is_potential_leak: group.is_potential_leak,
        count: group.count,
        total: group.total_paise / 100,
      })),
      warnings: groups
        .filter((group) => group.is_potential_leak && group.leak_count >= LEAK_WARNING_COUNT)
        .map((group) => ({ category: group.category, count: group.leak_count, total: group.leak_total_paise / 100 })),
      hourly: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        total: (hourlyByHour.get(hour)?.total_paise ?? 0) / 100,
        leak_total: (hourlyByHour.get(hour)?.leak_total_paise ?? 0) / 100,
      })),
    };
  }

  async report(userId, options = {}) {
    requireUserScope(userId);
    const range = getPeriodRange(options, this.now());
    const result = await this.repository.reportBetween(userId, range);
    const totalPaise = result.groups.reduce((sum, group) => sum + group.total_paise, 0);
    const leakPaise = result.groups.reduce((sum, group) => sum + group.leak_total_paise, 0);
    const dailyByDate = new Map(result.daily.map((entry) => [entry.date, entry]));
    const rounded = (value) => Math.round(value * 100) / 100;
    return {
      period: range.period, start_date: range.start_date, end_date: range.end_date,
      timezone: range.timezone, currency: 'INR', days_elapsed: range.days_elapsed,
      total_spent: totalPaise / 100,
      expense_count: result.groups.reduce((sum, group) => sum + group.count, 0),
      leak_total: leakPaise / 100,
      leak_count: result.groups.reduce((sum, group) => sum + group.leak_count, 0),
      daily_leak_velocity: rounded(leakPaise / 100 / range.days_elapsed),
      leak_share_percent: totalPaise ? rounded(leakPaise / totalPaise * 100) : 0,
      average_daily_spend: rounded(totalPaise / 100 / range.days_elapsed),
      groups: result.groups.map((group) => ({
        category: group.category, is_potential_leak: group.is_potential_leak,
        count: group.count, total: group.total_paise / 100,
      })),
      warnings: result.warnings.map((entry) => ({ category: entry.category, count: entry.count, total: entry.total_paise / 100 })),
      series: range.dates.map((date) => ({
        date, total: (dailyByDate.get(date)?.total_paise ?? 0) / 100,
        leak_total: (dailyByDate.get(date)?.leak_total_paise ?? 0) / 100,
      })),
      expenses: result.expenses.map(publicExpense),
      comparison: {
        start_date: range.comparison.start_date, end_date: range.comparison.end_date,
        days_elapsed: range.comparison.days_elapsed,
        total_spent: result.previous_total_paise / 100,
        current_total_spent: result.comparable_total_paise / 100,
        change_percent: result.previous_total_paise
          ? rounded((result.comparable_total_paise - result.previous_total_paise) / result.previous_total_paise * 100)
          : null,
      },
    };
  }
}
