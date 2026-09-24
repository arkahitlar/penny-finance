import { randomUUID } from 'node:crypto';

/** All auth identifiers use bound parameters; raw bearer tokens are never persisted. */
export class AuthRepository {
  constructor(client) { this.client = client; }

  async saveTransaction({ stateHash, nonce, codeVerifier, expiresAt }, now) {
    await this.client.batch([
      { sql: 'DELETE FROM auth_transactions WHERE expires_at <= ?', args: [now] },
      { sql: 'DELETE FROM sessions WHERE expires_at <= ?', args: [now] },
      { sql: 'INSERT INTO auth_transactions (state_hash, nonce, code_verifier, expires_at) VALUES (?, ?, ?, ?)', args: [stateHash, nonce, codeVerifier, expiresAt] },
    ], 'write');
  }

  async consumeTransaction(stateHash, now) {
    // DELETE RETURNING atomically consumes state, including concurrent callbacks.
    const result = await this.client.execute({
      sql: 'DELETE FROM auth_transactions WHERE state_hash = ? AND expires_at > ? RETURNING nonce, code_verifier',
      args: [stateHash, now],
    });
    return result.rows[0] ?? null;
  }

  async upsertGoogleUser({ sub, email, name }, now) {
    const result = await this.client.execute({
      sql: `INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name
        RETURNING id, email, name`,
      args: [randomUUID(), sub, email, name, new Date(now).toISOString()],
    });
    const row = result.rows[0];
    return { id: row.id, email: row.email, name: row.name };
  }

  async saveSession(tokenHash, userId, expiresAt, oldTokenHash) {
    const statements = [{
      sql: 'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      args: [tokenHash, userId, expiresAt],
    }];
    if (oldTokenHash) statements.push({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [oldTokenHash] });
    await this.client.batch(statements, 'write');
  }

  async findUserForSession(tokenHash, now) {
    const result = await this.client.execute({
      sql: `SELECT users.id, users.email, users.name FROM sessions
        JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      args: [tokenHash, now],
    });
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, name: row.name } : null;
  }

  async revokeSession(tokenHash) {
    await this.client.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [tokenHash] });
  }
}
