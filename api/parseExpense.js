import { ApiResponse } from '../lib/http/ApiResponse.js';
import { asyncHandler } from '../lib/http/asyncHandler.js';
import { readExpenseBody, readIdempotencyKey, requireMethod } from '../lib/http/request.js';
import { getExpenseService } from '../lib/services/container.js';
import { normalizeConfirmation } from '../lib/domain/expense.js';
import { requireUser, requireSameOrigin } from '../lib/auth/index.js';

export function createParseExpenseHandler({ service, authenticate = requireUser, checkOrigin = requireSameOrigin } = {}) {
  return asyncHandler(async (req, res) => {
    requireMethod(req, res, 'POST');
    const user = await authenticate(req);
    await checkOrigin(req);
    const choices = normalizeConfirmation(readExpenseBody(req));
    const key = readIdempotencyKey(req);
    const { expense, replayed } = await (service ?? getExpenseService()).confirm(user.id, choices, key);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return new ApiResponse(replayed ? 200 : 201, { expense }, replayed ? 'Expense already saved.' : 'Expense saved.').send(res);
  });
}

export default createParseExpenseHandler();
