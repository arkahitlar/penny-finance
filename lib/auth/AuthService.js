import { createHash } from 'node:crypto';
import { ApiError } from '../http/ApiError.js';
import { SESSION_SECONDS, TRANSACTION_SECONDS, checkSameOrigin } from './config.js';
import { hashToken, randomToken, readCookie, tokensEqual, writeCookie } from './cookies.js';

export class AuthService {
  constructor({ config, repository, provider, clock = Date.now }) {
    this.config = config;
    this.getRepository = typeof repository === 'function' ? repository : () => repository;
    this.provider = provider;
    this.clock = clock;
  }

  get configured() { return Boolean(this.config); }

  assertConfigured() {
    if (!this.config) throw new ApiError(503, 'Google sign-in is not configured yet.', 'AUTH_NOT_CONFIGURED');
  }

  requireSameOrigin(req) {
    this.assertConfigured();
    checkSameOrigin(req, this.config.origin);
  }

  async startLogin(req, res) {
    this.assertConfigured();
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const now = this.clock();
    await this.getRepository().saveTransaction({ stateHash: hashToken(state), nonce, codeVerifier, expiresAt: now + TRANSACTION_SECONDS * 1000 }, now);
    const url = this.provider.authorizationUrl({ state, nonce, codeChallenge });
    writeCookie(res, this.config.transactionCookie, state, { secure: this.config.secure, maxAge: TRANSACTION_SECONDS });
    return url;
  }

  clearTransaction(res) {
    if (this.config) writeCookie(res, this.config.transactionCookie, '', { secure: this.config.secure, maxAge: 0 });
  }

  async completeLogin(req, res, query) {
    this.assertConfigured();
    const browserState = readCookie(req, this.config.transactionCookie);
    if (!tokensEqual(query.state, browserState)) {
      throw new ApiError(401, 'Please start Google sign-in again.', 'INVALID_OAUTH_STATE');
    }
    const transaction = await this.getRepository().consumeTransaction(hashToken(query.state), this.clock());
    if (!transaction) throw new ApiError(401, 'Please start Google sign-in again.', 'INVALID_OAUTH_STATE');
    if (query.error || typeof query.code !== 'string' || !query.code || query.code.length > 4096) {
      throw new ApiError(401, 'Google sign-in was not completed.', 'SIGNIN_FAILED');
    }
    const identity = await this.provider.verifyCode({ code: query.code, codeVerifier: transaction.code_verifier, nonce: transaction.nonce });
    const now = this.clock();
    const user = await this.getRepository().upsertGoogleUser(identity, now);
    const token = randomToken();
    const oldToken = readCookie(req, this.config.sessionCookie);
    await this.getRepository().saveSession(hashToken(token), user.id, now + SESSION_SECONDS * 1000, oldToken ? hashToken(oldToken) : null);
    writeCookie(res, this.config.sessionCookie, token, { secure: this.config.secure, maxAge: SESSION_SECONDS });
    return user;
  }

  async currentUser(req) {
    if (!this.config) return null;
    const token = readCookie(req, this.config.sessionCookie);
    if (!token) return null;
    return this.getRepository().findUserForSession(hashToken(token), this.clock());
  }

  async requireUser(req) {
    const user = await this.currentUser(req);
    if (!user) throw new ApiError(401, 'Sign in with Google to continue.', 'UNAUTHENTICATED');
    return user;
  }

  async logout(req, res) {
    this.requireSameOrigin(req);
    const token = readCookie(req, this.config.sessionCookie);
    if (token) await this.getRepository().revokeSession(hashToken(token));
    writeCookie(res, this.config.sessionCookie, '', { secure: this.config.secure, maxAge: 0 });
    this.clearTransaction(res);
  }
}
