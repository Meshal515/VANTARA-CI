import { describe, expect, it } from 'vitest';
import worker from './index.ts';
import { sqliteEnv } from './test-d1.ts';

describe('legacy session endpoint retirement', () => {
  it('never mints a session from userId even if index.ts is deployed directly', async () => {
    const { env } = sqliteEnv({
      VANTARA_SESSION_SECRET: 'legacy-session-secret-for-tests-only-32',
      VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only-32-chars',
      VANTARA_DEVICE_PEPPER: 'device-pepper-for-tests-only-32-chars-x',
    });

    const response = await worker.fetch(
      new Request('https://worker.test/v1/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: '9e4b51d9-4ca0-4da2-9b1f-2205e67134ed',
        }),
      }),
      env,
      { waitUntil() {} },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
  });
});
