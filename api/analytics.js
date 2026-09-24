import { ApiResponse } from '../lib/http/ApiResponse.js';
import { asyncHandler } from '../lib/http/asyncHandler.js';
import { requireMethod } from '../lib/http/request.js';
import { getExpenseService } from '../lib/services/container.js';
import { requireUser } from '../lib/auth/index.js';

export function createAnalyticsHandler({ service, authenticate = requireUser } = {}) {
  return asyncHandler(async (req, res) => {
    requireMethod(req, res, 'GET');
    const user = await authenticate(req);
    return new ApiResponse(200, await (service ?? getExpenseService()).analyticsToday(user.id), 'Today’s spending analysis.').send(res);
  });
}

export default createAnalyticsHandler();
