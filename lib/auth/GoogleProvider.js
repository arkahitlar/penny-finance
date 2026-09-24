import { OAuth2Client } from 'google-auth-library';
import { ApiError } from '../http/ApiError.js';
import { tokensEqual } from './cookies.js';

/** Google's maintained verifier checks the token signature, issuer, audience and expiry. */
export class GoogleProvider {
  constructor(config, { clientFactory = (options) => new OAuth2Client(options), clock = Date.now } = {}) {
    this.config = config;
    this.clientFactory = clientFactory;
    this.clock = clock;
  }

  client(signal) {
    return this.clientFactory({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri,
      // Covers token exchange and certificate download, with a shared cancellation deadline.
      transporterOptions: { timeout: 8000, signal, retry: false, retryConfig: { retry: 0 } },
      useAuthRequestParameters: false,
    });
  }

  authorizationUrl({ state, nonce, codeChallenge }) {
    return this.client().generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      access_type: 'online',
      response_type: 'code',
      prompt: 'select_account',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  async verifyCode({ code, codeVerifier, nonce }) {
    try {
      const client = this.client(AbortSignal.timeout(12000));
      const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: this.config.redirectUri });
      if (!tokens?.id_token) throw new Error('Missing identity token');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.clientId });
      const payload = ticket.getPayload();
      if (!payload || !tokensEqual(payload.nonce, nonce) || !/^\d{1,255}$/.test(payload.sub ?? '') ||
          payload.aud !== this.config.clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss) ||
          (payload.azp !== undefined && payload.azp !== this.config.clientId) ||
          typeof payload.exp !== 'number' || payload.exp * 1000 <= this.clock() ||
          payload.email_verified !== true || typeof payload.email !== 'string' ||
          payload.email.length > 320 || !payload.email.includes('@')) throw new Error('Invalid identity claims');
      return {
        sub: payload.sub,
        email: payload.email,
        name: (typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : payload.email.split('@')[0]).slice(0, 120),
      };
    } catch {
      // Never send provider errors, OAuth codes or tokens back to the browser or logs.
      throw new ApiError(401, 'Google sign-in could not be completed. Please try again.', 'SIGNIN_FAILED');
    }
  }
}
