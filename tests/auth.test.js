import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { AuthRepository } from '../lib/auth/AuthRepository.js';
import { AuthService } from '../lib/auth/AuthService.js';
import { GoogleProvider } from '../lib/auth/GoogleProvider.js';
import { readAuthConfig, readAppOrigin, checkSameOrigin, SESSION_SECONDS } from '../lib/auth/config.js';
import { hashToken, randomToken } from '../lib/auth/cookies.js';
import { createAuthHandler } from '../api/auth.js';
import { mockRequest, mockResponse } from './helpers.js';

const NOW = Date.parse('2026-09-24T10:00:00Z');
const CONFIG = readAuthConfig({ APP_URL: 'https://penny.example', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' });
const IDENTITY = { sub: '123456789012345678901', email: 'person@example.com', name: 'Person' };
const cookiePair = (res, name) => res.getHeader('Set-Cookie').find((cookie) => cookie.startsWith(`${name}=`)).split(';', 1)[0];

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'penny-auth-test-'));
  const client = createClient({ url: `file:${path.join(directory, 'auth.db')}` });
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.executeMultiple(await readFile(new URL('../database/auth.sql', import.meta.url), 'utf8'));
  const repository = new AuthRepository(client);
  const calls = [];
  let now = NOW;
  let loginParams;
  const provider = {
    authorizationUrl(params) { loginParams = params; return 'https://accounts.google.com/o/oauth2/v2/auth'; },
    async verifyCode(params) { calls.push(params); return IDENTITY; },
  };
  const service = new AuthService({ config: CONFIG, repository, provider, clock: () => now });
  const begin = async () => {
    const res = mockResponse();
    await service.startLogin(mockRequest({ method: 'GET' }), res);
    return { params: loginParams, res, req: mockRequest({ method: 'GET', headers: { cookie: cookiePair(res, CONFIG.transactionCookie) } }) };
  };
  const signIn = async (extraHeaders = {}) => {
    const started = await begin();
    Object.assign(started.req.headers, extraHeaders);
    const res = mockResponse();
    const user = await service.completeLogin(started.req, res, { state: started.params.state, code: 'single-use-code' });
    return { user, res, req: mockRequest({ method: 'GET', headers: { cookie: cookiePair(res, CONFIG.sessionCookie) } }) };
  };
  return { client, repository, provider, service, begin, signIn, calls, setTime: (value) => { now = value; } };
}

test('auth config requires a fixed safe origin and deployment never permits HTTP', () => {
  assert.equal(readAuthConfig({}), null);
  assert.equal(readAppOrigin({ APP_URL: 'http://localhost:3000' }), 'http://localhost:3000');
  assert.equal(CONFIG.redirectUri, 'https://penny.example/api/auth?action=callback');
  for (const APP_URL of ['http://penny.example', 'https://penny.example/path', 'https://x:p@penny.example', 'https://penny.example?x=1', 'https://penny.example#x']) {
    assert.throws(() => readAppOrigin({ APP_URL }), { code: 'AUTH_NOT_CONFIGURED' });
  }
  assert.throws(() => readAppOrigin({ APP_URL: 'http://localhost:3000', NODE_ENV: 'production' }));
  assert.throws(() => readAppOrigin({ APP_URL: 'http://localhost:3000', VERCEL: '1' }));
});

test('login sets a secure host-only cookie and stores only a state hash with nonce and PKCE', async (t) => {
  const { client, begin } = await fixture(t);
  const { params, res } = await begin();
  assert.notEqual(params.state, params.nonce);
  assert.match(params.state, /^[A-Za-z0-9_-]{43}$/);
  const row = (await client.execute('SELECT * FROM auth_transactions')).rows[0];
  assert.equal(row.state_hash, hashToken(params.state));
  assert.equal(row.nonce, params.nonce);
  assert.equal(params.codeChallenge, createHash('sha256').update(row.code_verifier).digest('base64url'));
  assert.equal(Number(row.expires_at), NOW + 600000);
  const cookie = res.getHeader('Set-Cookie')[0];
  assert.match(cookie, /^__Host-penny_oauth=/);
  assert.match(cookie, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  assert.equal(cookie.includes('Domain='), false);
});

test('Google authorization URL requests only identity scopes with state, nonce and S256', () => {
  const provider = new GoogleProvider(CONFIG);
  const state = randomToken();
  const nonce = randomToken();
  const codeChallenge = randomToken();
  const url = new URL(provider.authorizationUrl({ state, nonce, codeChallenge }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('nonce'), nonce);
  assert.equal(url.searchParams.get('code_challenge'), codeChallenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'online');
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('a missing or mismatched browser state cannot consume another login transaction', async (t) => {
  const { client, service, begin, calls } = await fixture(t);
  const { params, req } = await begin();
  for (const invalid of [mockRequest(), mockRequest({ headers: { cookie: `${CONFIG.transactionCookie}=${randomToken()}` } })]) {
    await assert.rejects(service.completeLogin(invalid, mockResponse(), { state: params.state, code: 'code' }), { code: 'INVALID_OAUTH_STATE' });
  }
  await assert.rejects(service.completeLogin(req, mockResponse(), { state: randomToken(), code: 'code' }), { code: 'INVALID_OAUTH_STATE' });
  assert.equal(calls.length, 0);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS n FROM auth_transactions')).rows[0].n), 1);
});

test('state is consumed atomically so parallel callbacks issue exactly one session', async (t) => {
  const { client, service, begin, calls } = await fixture(t);
  const { params, req } = await begin();
  const results = await Promise.allSettled([0, 1].map(() => service.completeLogin(req, mockResponse(), { state: params.state, code: 'code' })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'INVALID_OAUTH_STATE');
  assert.equal(calls.length, 1);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS n FROM sessions')).rows[0].n), 1);
});

test('expired and cancelled login attempts cannot create a session', async (t) => {
  const { service, begin, setTime, calls } = await fixture(t);
  const first = await begin();
  setTime(NOW + 600000);
  await assert.rejects(service.completeLogin(first.req, mockResponse(), { state: first.params.state, code: 'code' }), { code: 'INVALID_OAUTH_STATE' });
  const cancelled = await begin();
  await assert.rejects(service.completeLogin(cancelled.req, mockResponse(), { state: cancelled.params.state, error: 'access_denied' }), { code: 'SIGNIN_FAILED' });
  await assert.rejects(service.completeLogin(cancelled.req, mockResponse(), { state: cancelled.params.state, code: 'code' }), { code: 'INVALID_OAUTH_STATE' });
  assert.equal(calls.length, 0);
});

test('session tokens are random, hashed in SQLite, private in JSON, and expire exactly at 30 days', async (t) => {
  const { client, service, signIn, setTime, calls } = await fixture(t);
  const { user, req, res } = await signIn();
  assert.deepEqual(await service.requireUser(req), user);
  assert.deepEqual(Object.keys(user).sort(), ['email', 'id', 'name']);
  const token = req.headers.cookie.split('=')[1];
  const row = (await client.execute('SELECT * FROM sessions')).rows[0];
  assert.equal(row.token_hash, hashToken(token));
  assert.equal(Number(row.expires_at), NOW + SESSION_SECONDS * 1000);
  assert.equal(JSON.stringify(row).includes(token), false);
  assert.match(res.getHeader('Set-Cookie')[0], /Max-Age=2592000; Secure$/);
  assert.equal(calls[0].code, 'single-use-code');
  assert.match(calls[0].codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  setTime(NOW + SESSION_SECONDS * 1000);
  assert.equal(await service.currentUser(req), null);
  await assert.rejects(service.requireUser(req), { statusCode: 401 });
});

test('tampered, absent, unknown and duplicate session cookies are unauthorized', async (t) => {
  const { service, signIn } = await fixture(t);
  const signed = await signIn();
  for (const cookie of ['', `${CONFIG.sessionCookie}=invalid`, `${CONFIG.sessionCookie}=${randomToken()}`, `${signed.req.headers.cookie}; ${signed.req.headers.cookie}`]) {
    const req = mockRequest({ headers: { cookie } });
    assert.equal(await service.currentUser(req), null);
    await assert.rejects(service.requireUser(req), { code: 'UNAUTHENTICATED' });
  }
});

test('signing in again rotates and revokes the previous browser session', async (t) => {
  const { service, signIn, begin } = await fixture(t);
  const previous = await signIn();
  const started = await begin();
  started.req.headers.cookie += `; ${previous.req.headers.cookie}`;
  const res = mockResponse();
  const user = await service.completeLogin(started.req, res, { state: started.params.state, code: 'new-code' });
  assert.equal(user.id, previous.user.id);
  assert.equal(await service.currentUser(previous.req), null);
  assert.notEqual(cookiePair(res, CONFIG.sessionCookie), previous.req.headers.cookie);
});

test('users are linked only by immutable Google subject, never by email', async (t) => {
  const { repository } = await fixture(t);
  const first = await repository.upsertGoogleUser(IDENTITY, NOW);
  const changed = await repository.upsertGoogleUser({ ...IDENTITY, email: 'changed@example.com' }, NOW);
  const different = await repository.upsertGoogleUser({ ...IDENTITY, sub: '987654321012345678901' }, NOW);
  assert.equal(first.id, changed.id);
  assert.notEqual(first.id, different.id);
  assert.equal(changed.email, 'changed@example.com');
});

test('logout rejects missing or cross-site origins, then revokes and clears a valid session', async (t) => {
  const { service, signIn } = await fixture(t);
  const { req } = await signIn();
  for (const origin of [undefined, 'https://evil.example', 'null', `${CONFIG.origin}/`]) {
    await assert.rejects(service.logout(mockRequest({ headers: { ...req.headers, origin } }), mockResponse()), { code: 'INVALID_ORIGIN' });
    assert.ok(await service.currentUser(req));
  }
  const res = mockResponse();
  await service.logout(mockRequest({ headers: { ...req.headers, origin: CONFIG.origin } }), res);
  assert.equal(await service.currentUser(req), null);
  assert.ok(res.getHeader('Set-Cookie').every((cookie) => cookie.includes('Max-Age=0')));
  assert.equal(res.getHeader('Set-Cookie').length, 2);
  assert.doesNotThrow(() => checkSameOrigin({ headers: { origin: CONFIG.origin } }, CONFIG.origin));
});

test('official verifier receives audience and PKCE; verified nonce and claims are checked before identity is used', async () => {
  const nonce = randomToken();
  const claims = { ...IDENTITY, aud: CONFIG.clientId, iss: 'https://accounts.google.com', exp: NOW / 1000 + 3600, nonce, email_verified: true };
  const calls = {};
  let payload = claims;
  let rejectVerification = false;
  const provider = new GoogleProvider(CONFIG, {
    clock: () => NOW,
    clientFactory(options) {
      calls.options = options;
      return {
        async getToken(options) { calls.exchange = options; return { tokens: { id_token: 'private-id-token', access_token: 'not-stored' } }; },
        async verifyIdToken(options) { calls.verify = options; if (rejectVerification) throw new Error('private-provider-error'); return { getPayload: () => payload }; },
      };
    },
  });
  assert.deepEqual(await provider.verifyCode({ code: 'private-code', codeVerifier: 'private-verifier', nonce }), IDENTITY);
  assert.deepEqual(calls.verify, { idToken: 'private-id-token', audience: CONFIG.clientId });
  assert.deepEqual(calls.exchange, { code: 'private-code', codeVerifier: 'private-verifier', redirect_uri: CONFIG.redirectUri });
  assert.ok(calls.options.transporterOptions.signal instanceof AbortSignal);
  assert.equal(calls.options.transporterOptions.timeout, 8000);
  assert.equal(calls.options.useAuthRequestParameters, false);
  for (const changes of [{ nonce: randomToken() }, { nonce: undefined }, { aud: 'other-client' }, { azp: 'other-client' }, { iss: 'https://evil.example' }, { exp: NOW / 1000 }, { email_verified: false }, { sub: 'legacy:unclaimed' }]) {
    payload = { ...claims, ...changes };
    await assert.rejects(provider.verifyCode({ code: 'private-code', codeVerifier: 'private-verifier', nonce }), { code: 'SIGNIN_FAILED' });
  }
  payload = claims;
  rejectVerification = true;
  await assert.rejects(provider.verifyCode({ code: 'private-code', codeVerifier: 'private-verifier', nonce }), (error) => {
    assert.equal(error.code, 'SIGNIN_FAILED');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});

test('callback failures use a safe redirect and clear OAuth cookie; login and session use no-store', async (t) => {
  const { service, begin } = await fixture(t);
  const handler = createAuthHandler({ service });
  const failure = mockResponse();
  await handler(mockRequest({ method: 'GET', url: '/api/auth?action=callback&state=bad&code=secret-provider-code' }), failure);
  assert.equal(failure.statusCode, 302);
  assert.equal(failure.headers.location, '/?auth_error=signin_failed');
  assert.match(failure.getHeader('Set-Cookie')[0], /Max-Age=0/);
  assert.equal(failure.headers['referrer-policy'], 'no-referrer');
  const started = await begin();
  started.req.url = `/api/auth?action=callback&state=${started.params.state}&code=code`;
  const success = mockResponse();
  await handler(started.req, success);
  assert.equal(success.headers.location, '/');
  assert.equal(success.headers['cache-control'], 'no-store');
  const session = mockResponse();
  await handler(mockRequest({ method: 'GET', url: '/api/auth?action=session', headers: { cookie: cookiePair(success, CONFIG.sessionCookie) } }), session);
  assert.equal(session.body.data.configured, true);
  assert.equal(session.body.data.user.email, IDENTITY.email);
  assert.equal(session.headers['cache-control'], 'no-store');
  assert.equal(JSON.stringify(session.body).includes('test-secret'), false);
});

test('unconfigured auth has no bypass and method enforcement prevents GET logout', async () => {
  const service = new AuthService({ config: null, repository: () => { throw new Error('must not access storage'); } });
  const handler = createAuthHandler({ service });
  const session = mockResponse();
  await handler(mockRequest({ method: 'GET', url: '/api/auth?action=session&demo=1' }), session);
  assert.deepEqual(session.body.data, { user: null, configured: false });
  await assert.rejects(service.requireUser(mockRequest()), { code: 'UNAUTHENTICATED' });
  const logout = mockResponse();
  await handler(mockRequest({ method: 'GET', url: '/api/auth?action=logout' }), logout);
  assert.equal(logout.statusCode, 405);
  const login = mockResponse();
  await handler(mockRequest({ method: 'GET', url: '/api/auth?action=login' }), login);
  assert.equal(login.statusCode, 503);
});
