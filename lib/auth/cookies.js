import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url');
export const hashToken = (value) => createHash('sha256').update(value).digest('hex');
export const validToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function tokensEqual(left, right) {
  return validToken(left) && validToken(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string' || header.length > 16384) return null;
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  // Ambiguous duplicate cookies must not select a session based on ordering.
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return validToken(value) ? value : null;
}

export function writeCookie(res, name, value, { secure, maxAge }) {
  const cookie = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(existing ? (Array.isArray(existing) ? existing : [existing]) : []), cookie]);
}
