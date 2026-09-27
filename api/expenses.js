import { ApiError } from '../lib/http/ApiError.js';
import { ApiResponse } from '../lib/http/ApiResponse.js';
import { asyncHandler } from '../lib/http/asyncHandler.js';
import { readExpenseBody } from '../lib/http/request.js';
import { getExpenseService } from '../lib/services/container.js';
import { requireUser, requireSameOrigin } from '../lib/auth/index.js';

export function createExpensesHandler({ service, authenticate = requireUser, checkOrigin = requireSameOrigin } = {}) {
  return asyncHandler(async (req, res) => {
    if (!['GET', 'PATCH', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, PATCH, DELETE');
      throw new ApiError(405, 'Use GET, PATCH, or DELETE for this endpoint.', 'METHOD_NOT_ALLOWED');
    }
    const user = await authenticate(req);
    const expenseService = service ?? getExpenseService();
    if (req.method === 'GET') return new ApiResponse(200, await expenseService.listToday(user.id), 'Today’s expenses.').send(res);
    await checkOrigin(req);
    const input = readExpenseBody(req);
    const result = await expenseService[req.method === 'PATCH' ? 'update' : 'delete'](user.id, input);
    return new ApiResponse(200, result, req.method === 'PATCH' ? 'Expense updated.' : 'Expense deleted.').send(res);
  });
}

export default createExpensesHandler();
