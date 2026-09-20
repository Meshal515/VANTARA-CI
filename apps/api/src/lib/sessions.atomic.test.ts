import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@vantara/db', () => ({
  query: db.query,
  queryOne: db.queryOne,
  transaction: db.transaction,
}));

const { SessionStore } = await import('./sessions.ts');

function upstream() {
  return {
    login: vi.fn(async () => ({
      accessToken: 'short-login-token',
      user: {
        id: 'upstream-user-1',
        username: 'mansour',
        displayName: 'Mansour',
        role: 'user',
      },
    })),
    mintToken: vi.fn(async () => ({
      id: 'minted-token-id',
      token: 'minted-long-lived-token',
    })),
    revokeToken: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionStore.login atomicity', () => {
  it('revokes the freshly minted upstream credential when database persistence fails', async () => {
    const service = upstream();
    db.transaction.mockRejectedValueOnce(new Error('database unavailable'));

    const store = new SessionStore({
      key: Buffer.alloc(32, 7),
      ttlDays: 60,
      uchiyomi: service as never,
    });

    await expect(store.login('mansour', 'password', 'ci-device')).rejects.toThrow(
      'database unavailable',
    );

    expect(service.mintToken).toHaveBeenCalledTimes(1);
    expect(service.revokeToken).toHaveBeenCalledTimes(1);
    expect(service.revokeToken).toHaveBeenCalledWith(
      'minted-long-lived-token',
      'minted-token-id',
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  it('persists user, identity link, and session inside one transaction', async () => {
    const service = upstream();
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    db.transaction.mockImplementationOnce(async (fn: (client: typeof client) => Promise<unknown>) =>
      fn(client),
    );

    const store = new SessionStore({
      key: Buffer.alloc(32, 9),
      ttlDays: 60,
      uchiyomi: service as never,
    });

    const session = await store.login('mansour', 'password', 'ci-device');

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(service.revokeToken).not.toHaveBeenCalled();
    expect(session).toMatchObject({
      userId: 'upstream-user-1',
      username: 'mansour',
      token: 'minted-long-lived-token',
      tokenId: 'minted-token-id',
    });
  });
});
