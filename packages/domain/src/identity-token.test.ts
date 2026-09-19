import { describe, expect, it } from 'vitest';
import * as identity from './index.ts';

const SECRET = 'test-secret-that-is-long-enough-for-hmac-signing';

describe('B2 unified identity token', () => {
  it('provides a shared device-bound access-token API', () => {
    expect(typeof (identity as Record<string, unknown>)['mintIdentityToken']).toBe('function');
    expect(typeof (identity as Record<string, unknown>)['verifyIdentityToken']).toBe('function');
  });

  it('mints a short-lived token carrying the canonical identity and device', async () => {
    const mint = (identity as Record<string, unknown>)['mintIdentityToken'];
    const verify = (identity as Record<string, unknown>)['verifyIdentityToken'];
    if (typeof mint !== 'function' || typeof verify !== 'function') {
      expect.fail('identity token API is not implemented');
    }

    const now = Date.UTC(2026, 8, 17, 20, 0, 0);
    const token = await (mint as Function)(
      { userId: 'bedcf897-a6f0-4730-b757-402b14891ca5', deviceId: 'device-a' },
      SECRET,
      now,
    );
    const claims = await (verify as Function)(token, SECRET, now + 1_000);

    expect(claims).toMatchObject({
      version: 2,
      userId: 'bedcf897-a6f0-4730-b757-402b14891ca5',
      deviceId: 'device-a',
    });
    expect(claims.expiresAt - claims.issuedAt).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it('rejects an expired or forged token', async () => {
    const mint = (identity as Record<string, unknown>)['mintIdentityToken'];
    const verify = (identity as Record<string, unknown>)['verifyIdentityToken'];
    if (typeof mint !== 'function' || typeof verify !== 'function') {
      expect.fail('identity token API is not implemented');
    }

    const now = Date.UTC(2026, 8, 17, 20, 0, 0);
    const token = await (mint as Function)(
      { userId: 'user-a', deviceId: 'device-a' },
      SECRET,
      now,
    );
    expect(await (verify as Function)(token, SECRET, now + 16 * 60 * 1000)).toBeNull();
    expect(await (verify as Function)(`${token}x`, SECRET, now + 1_000)).toBeNull();
  });
});
