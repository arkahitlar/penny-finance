import { ApiError } from '../lib/http/ApiError.js';
import { ApiResponse } from '../lib/http/ApiResponse.js';
import { asyncHandler } from '../lib/http/asyncHandler.js';
import { requireMethod } from '../lib/http/request.js';
import { getAuthService } from '../lib/auth/index.js';

function redirect(res, location) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Location', location);
  return res.status(302).end();
}

export function createAuthHandler({ service } = {}) {
  return asyncHandler(async (req, res) => {
    const query = req.query ?? Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const action = query.action ?? 'session';
    if (action === 'callback') {
      requireMethod(req, res, 'GET');
      let auth;
      try {
        auth = service ?? getAuthService();
        await auth.completeLogin(req, res, query);
        auth.clearTransaction(res);
        return redirect(res, '/');
      } catch {
        auth?.clearTransaction(res);
        return redirect(res, '/?auth_error=signin_failed');
      }
    }
    const auth = service ?? getAuthService();
    if (action === 'session') {
      requireMethod(req, res, 'GET');
      return new ApiResponse(200, { user: await auth.currentUser(req), configured: auth.configured }).send(res);
    }
    if (action === 'login') {
      requireMethod(req, res, 'GET');
      return redirect(res, await auth.startLogin(req, res));
    }
    if (action === 'logout') {
      requireMethod(req, res, 'POST');
      await auth.logout(req, res);
      return new ApiResponse(200, { user: null }, 'Signed out.').send(res);
    }
    throw new ApiError(404, 'That sign-in action does not exist.', 'NOT_FOUND');
  });
}

export default createAuthHandler();
