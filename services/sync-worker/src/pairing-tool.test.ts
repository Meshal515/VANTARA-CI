import { describe, expect, it } from 'vitest';
import { hashDeviceSecret } from './secure-index.ts';

async function provisioningModule() {
  try {
    // @ts-expect-error -- RED state: the provisioning module is deliberately absent until this test fails.
    return await import('../tools/create-pairing-token.mjs');
  } catch (error) {
    expect.fail(`pairing token provisioning tool is missing: ${String(error)}`);
  }
}

describe('B2 owner pairing-token provisioning', () => {
  it('uses the exact same HMAC contract as the Worker and produces a short-lived record', async () => {
    const mod = await provisioningModule();
    expect(typeof mod?.createPairingRecord).toBe('function');

    const token = 'owner-pairing-token-0000000000000001';
    const pepper = 'device-pepper-for-provisioning-contract-test';
    const now = Date.UTC(2026, 8, 18, 4, 30, 0);
    const record = mod!.createPairingRecord({
      token,
      pepper,
      userId: null,
      now,
      ttlMs: 10 * 60_000,
    });

    expect(record).toEqual({
      token,
      tokenHash: await hashDeviceSecret(token, pepper),
      userId: null,
      createdAt: now,
      expiresAt: now + 10 * 60_000,
    });
  });

  it('builds an insert that stores the HMAC only, never the raw pairing token', async () => {
    const mod = await provisioningModule();
    expect(typeof mod?.buildPairingInsertSql).toBe('function');

    const record = {
      token: 'raw-token-must-not-enter-sql-00000001',
      tokenHash: 'a'.repeat(64),
      userId: "user-with-'quote",
      createdAt: 1000,
      expiresAt: 2000,
    };
    const sql = mod!.buildPairingInsertSql(record);

    expect(sql).toContain('INSERT INTO pairing_tokens');
    expect(sql).toContain("'user-with-''quote'");
    expect(sql).toContain(record.tokenHash);
    expect(sql).not.toContain(record.token);
  });
});
