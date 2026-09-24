/** An expected, safe-to-display API failure. Never include provider or database secrets. */
export class ApiError extends Error {
  constructor(statusCode, message, code = 'INTERNAL_ERROR', details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
