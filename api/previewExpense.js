import { ApiResponse } from '../lib/http/ApiResponse.js';
import { asyncHandler } from '../lib/http/asyncHandler.js';
import { readExpenseBody, requireMethod } from '../lib/http/request.js';
import { getExpenseService } from '../lib/services/container.js';
import { normalizeExpenseText } from '../lib/domain/expense.js';
import { requireUser, requireSameOrigin } from '../lib/auth/index.js';

export function createPreviewExpenseHandler({ service, authenticate = requireUser, checkOrigin = requireSameOrigin } = {}) {
  return asyncHandler(async (req, res) => {
    requireMethod(req, res, 'POST');
    const user = await authenticate(req);
    await checkOrigin(req);
    const text = normalizeExpenseText(readExpenseBody(req).text);
    const result = await (service ?? getExpenseService()).preview(user.id, text);
    return new ApiResponse(200, result, 'Review your expense and choose how you paid.').send(res);
  });
}

export default createPreviewExpenseHandler();
