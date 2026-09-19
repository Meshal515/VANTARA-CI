import { describe, expect, it } from 'vitest';
import worker from './index.ts';
import { mintToken } from './session.ts';
import { sqliteEnv } from './test-d1.ts';

const SECRET = 'activity-integrity-secret-at-least-32-chars';
const USER = '9e4b51d9-4ca0-4da2-9b1f-2205e67134ed';

describe('activity integrity', () => {
  it('settles legacy activity.add without publishing an unverified event', async () => {
    const { env, db } = sqliteEnv({
      VANTARA_SESSION_SECRET: SECRET,
      VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only-32-chars',
      VANTARA_DEVICE_PEPPER: 'device-pepper-for-tests-only-32-chars-x',
    });
    const token = await mintToken(USER, SECRET);
    const response = await worker.fetch(
      new Request('https://worker.test/v1/ops', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ops: [
            {
              opId: 'fabricated-event',
              kind: 'activity.add',
              payload: { verb: 'RATED_WORK', seriesRef: 'series:never-rated', payload: { score: 10 } },
            },
          ],
        }),
      }),
      env,
      { waitUntil: () => {} },
    );
    const body = (await response.json()) as { applied: string[]; skipped: string[] };

    expect(response.status).toBe(200);
    expect(body.applied).not.toContain('fabricated-event');
    expect(body.skipped).toContain('fabricated-event');
    const row = db.prepare('SELECT count(*) AS count FROM activity').get() as { count: number };
    expect(row.count).toBe(0);
  });
});
