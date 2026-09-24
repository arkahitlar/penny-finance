import { ApiError } from './ApiError.js';
import { ApiResponse } from './ApiResponse.js';

/** A single boundary for errors from asynchronous routes. */
export function asyncHandler(handler) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      const safeError = error instanceof ApiError
        ? error
        : new ApiError(500, 'Something went wrong. Please try again.', 'INTERNAL_ERROR');
      if (!(error instanceof ApiError)) {
        // Do not log expense text, SQL, provider payloads, credentials, or request bodies.
        console.error('Unhandled API failure', { name: error?.name ?? 'Error' });
      }
      return ApiResponse.fromError(safeError).send(res);
    }
  };
}
