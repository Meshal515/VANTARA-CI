import { describe, expect, it } from 'vitest';
import { verifyIdentityToken } from '@vantara/domain';
import worker from './secure-index.ts';
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  Env,
  ExecutionContext,
} from './types.ts';

interface DeviceRow {
  deviceId: string;
  userId: string;
  credentialHash: string;
  revokedAt: number | null;
  lastUsedAt: number;
}

interface AccountRow {
  userId: string;
  username: string;
  displayName: string | null;
}

class FakeStatement implements D1PreparedStatement {
  readonly #db: FakeDb;
  readonly #sql: string;
  #values: unknown[] = [];

  constructor(db: FakeDb, sql: string) {
    this.#db = db;
    this.#sql = sql.replace(/\s+/g, ' ').trim();
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.#values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.#sql.includes('FROM trusted_devices')) {
      const [deviceId, userId, credentialHash] = this.#values as [string, string, string];
      const row = this.#db.devices.find(
        (device) =>
          device.deviceId === deviceId &&
          device.userId === userId &&
          device.credentialHash === credentialHash &&
          device.revokedAt === null,
      );
      return (row ? ({ ok: 1 } as T) : null);
    }

    if (this.#sql.includes('FROM accounts a LEFT JOIN profiles p')) {
      const [userId] = this.#values as [string];
      const row = this.#db.accounts.find((account) => account.userId === userId);
      if (!row) return null;
      return {
        user_id: row.userId,
        username: row.username,
        display_name: row.displayName,
      } as T;
    }

    throw new Error(`Unhandled first(): ${this.#sql}`);
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    throw new Error(`Unhandled all(): ${this.#sql}`);
  }

  async run(): Promise<D1Result> {
    if (this.#sql.startsWith('UPDATE trusted_devices SET last_used_at')) {
      const [now, deviceId, userId] = this.#values as [number, string, string];
      const row = this.#db.devices.find(
        (device) =>
          device.deviceId === deviceId && device.userId === userId && device.revokedAt === null,
      );
      if (!row) return result(0);
      row.lastUsedAt = now;
      return result(1);
    }

    if (
      this.#sql.startsWith('UPDATE trusted_devices SET revoked_at') &&
      this.#sql.includes('device_id = ?')
    ) {
      const [now, deviceId, userId] = this.#values as [number, string, string];
      const row = this.#db.devices.find(
        (device) =>
          device.deviceId === deviceId && device.userId === userId && device.revokedAt === null,
      );
      if (!row) return result(0);
      row.revokedAt = now;
      return result(1);
    }

    if (
      this.#sql.startsWith('UPDATE trusted_devices SET revoked_at') &&
      this.#sql.includes('user_id = ?')
    ) {
      const [now, userId] = this.#values as [number, string];
      let changes = 0;
      for (const row of this.#db.devices) {
        if (row.userId === userId && row.revokedAt === null) {
          row.revokedAt = now;
          changes += 1;
        }
      }
      return result(changes);
    }

    throw new Error(`Unhandled run(): ${this.#sql}`);
  }
}

class FakeDb implements D1Database {
  readonly accounts: AccountRow[] = [];
  readonly devices: DeviceRow[] = [];

  prepare(query: string): D1PreparedStatement {
    return new FakeStatement(this, query);
  }

  async batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    throw new Error('batch is not used by these tests');
  }

  async exec(_query: string): Promise<{ count: number; duration: number }> {
    return { count: 0, duration: 0 };
  }
}

function result(changes: number): D1Result {
  return { results: [], success: true, meta: { changes } };
}

const ctx: ExecutionContext = { waitUntil() {} };

function env(db: FakeDb): Env {
  return {
    DB: db,
    VANTARA_SESSION_SECRET: 'legacy-session-secret-for-tests-only',
    VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only',
    VANTARA_DEVICE_PEPPER: 'device-pepper-for-tests-only',
  };
}

async function credentialHash(credential: string, pepper: string): Promise<string> {
  const { hashDeviceSecret } = await import('./secure-index.ts');
  return hashDeviceSecret(credential, pepper);
}

async function seedTrusted(
  db: FakeDb,
  userId: string,
  deviceId: string,
  credential: string,
  revokedAt: number | null = null,
): Promise<void> {
  const testEnv = env(db);
  db.devices.push({
    deviceId,
    userId,
    credentialHash: await credentialHash(credential, testEnv.VANTARA_DEVICE_PEPPER),
    revokedAt,
    lastUsedAt: 0,
  });
}

function sessionRequest(userId: string, deviceId?: string, deviceCredential?: string): Request {
  return new Request('https://sync.example/v1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, deviceId, deviceCredential }),
  });
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('B2 trusted-device session gate', () => {
  it('rejects userId without device proof', async () => {
    const db = new FakeDb();
    db.accounts.push({ userId: 'user-1', username: 'meshal', displayName: 'Meshal' });

    const response = await worker.fetch(sessionRequest('user-1'), env(db), ctx);

    expect(response.status).toBe(401);
    await expect(jsonBody(response)).resolves.toMatchObject({ error: 'device_proof_required' });
  });

  it('rejects a wrong or revoked device credential', async () => {
    const db = new FakeDb();
    const userId = 'user-1';
    const deviceId = 'device-0001';
    const credential = 'correct-device-credential-00000001';
    db.accounts.push({ userId, username: 'meshal', displayName: 'Meshal' });
    await seedTrusted(db, userId, deviceId, credential);

    const wrong = await worker.fetch(
      sessionRequest(userId, deviceId, 'wrong-device-credential-000000000'),
      env(db),
      ctx,
    );
    expect(wrong.status).toBe(401);

    db.devices[0]!.revokedAt = Date.now();
    const revoked = await worker.fetch(sessionRequest(userId, deviceId, credential), env(db), ctx);
    expect(revoked.status).toBe(401);
  });

  it('issues a 15-minute v2 identity token bound to the trusted user and device', async () => {
    const db = new FakeDb();
    const userId = 'user-1';
    const deviceId = 'device-0001';
    const credential = 'correct-device-credential-00000001';
    db.accounts.push({ userId, username: 'meshal', displayName: 'Meshal' });
    await seedTrusted(db, userId, deviceId, credential);
    const testEnv = env(db);

    const response = await worker.fetch(sessionRequest(userId, deviceId, credential), testEnv, ctx);
    const body = await jsonBody(response);

    expect(response.status).toBe(200);
    expect(typeof body['token']).toBe('string');
    const claims = await verifyIdentityToken(
      String(body['token']),
      testEnv.VANTARA_IDENTITY_SECRET,
      Date.now(),
    );
    expect(claims).toMatchObject({ version: 2, userId, deviceId });
    expect((claims?.expiresAt ?? 0) - (claims?.issuedAt ?? 0)).toBe(15 * 60 * 1000);
  });

  it('logout-device revokes the device so it cannot mint another session', async () => {
    const db = new FakeDb();
    const userId = 'user-1';
    const deviceId = 'device-0001';
    const credential = 'correct-device-credential-00000001';
    db.accounts.push({ userId, username: 'meshal', displayName: 'Meshal' });
    await seedTrusted(db, userId, deviceId, credential);
    const testEnv = env(db);

    const issued = await worker.fetch(sessionRequest(userId, deviceId, credential), testEnv, ctx);
    const token = String((await jsonBody(issued))['token']);
    const logout = await worker.fetch(
      new Request('https://sync.example/v1/device/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      testEnv,
      ctx,
    );
    expect(logout.status).toBe(204);

    const retry = await worker.fetch(sessionRequest(userId, deviceId, credential), testEnv, ctx);
    expect(retry.status).toBe(401);
  });

  it('logout-all revokes every trusted device for the identity', async () => {
    const db = new FakeDb();
    const userId = 'user-1';
    const firstId = 'device-0001';
    const secondId = 'device-0002';
    const firstCredential = 'first-device-credential-0000000001';
    const secondCredential = 'second-device-credential-000000001';
    db.accounts.push({ userId, username: 'meshal', displayName: 'Meshal' });
    await seedTrusted(db, userId, firstId, firstCredential);
    await seedTrusted(db, userId, secondId, secondCredential);
    const testEnv = env(db);

    const issued = await worker.fetch(sessionRequest(userId, firstId, firstCredential), testEnv, ctx);
    const token = String((await jsonBody(issued))['token']);
    const logout = await worker.fetch(
      new Request('https://sync.example/v1/device/logout-all', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      testEnv,
      ctx,
    );
    expect(logout.status).toBe(200);
    await expect(jsonBody(logout)).resolves.toMatchObject({ revoked: 2 });

    const firstRetry = await worker.fetch(
      sessionRequest(userId, firstId, firstCredential),
      testEnv,
      ctx,
    );
    const secondRetry = await worker.fetch(
      sessionRequest(userId, secondId, secondCredential),
      testEnv,
      ctx,
    );
    expect(firstRetry.status).toBe(401);
    expect(secondRetry.status).toBe(401);
  });
});
