export const DEFAULT_PARSING_LIMITS = Object.freeze({ perMinute: 20, perDay: 200 });

export function parsingLimits(value = DEFAULT_PARSING_LIMITS) {
  if (!value || !['perMinute', 'perDay'].every((key) => Number.isSafeInteger(value[key]) && value[key] > 0)) {
    throw new TypeError('Parsing limits must be positive integers.');
  }
  return Object.freeze({ perMinute: value.perMinute, perDay: value.perDay });
}
