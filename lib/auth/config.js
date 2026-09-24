import { ApiError } from '../http/ApiError.js';

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const TRANSACTION_SECONDS = 10 * 60;

export function readAppOrigin(env = process.env) {
  let url;
  try { url = new URL(env.APP_URL); } catch {
    throw new ApiError(503, 'Google sign-in is not configured yet.', 'AUTH_NOT_CONFIGURED');
  }
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const localHttp = url.protocol === 'http:' && localhost && env.NODE_ENV !== 'production' && !env.VERCEL;
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || env.APP_URL.replace(/\/$/, '') !== url.origin) {
    throw new ApiError(503, 'Google sign-in is not configured yet.', 'AUTH_NOT_CONFIGURED');
  }
  return url.origin;
}

export function readAuthConfig(env = process.env) {
  if (!env.APP_URL || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const origin = readAppOrigin(env);
  const secure = origin.startsWith('https:');
  return Object.freeze({
    origin,
    secure,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${origin}/api/auth?action=callback`,
    sessionCookie: secure ? '__Host-penny_session' : 'penny_session',
    transactionCookie: secure ? '__Host-penny_oauth' : 'penny_oauth',
  });
}

export function checkSameOrigin(req, origin) {
  if (typeof req.headers?.origin !== 'string' || req.headers.origin !== origin) {
    throw new ApiError(403, 'Please make this request from Penny.', 'INVALID_ORIGIN');
  }
}
