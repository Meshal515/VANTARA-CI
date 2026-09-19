import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPool } from './index.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PostgreSQL pool failure handling', () => {
  it('handles idle-client errors so a database restart is not an uncaught process error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = createPool({
      connectionString: 'postgres://unused:unused@127.0.0.1:1/unused',
    });

    expect(pool.listenerCount('error')).toBeGreaterThan(0);

    // No connection is opened by constructing a Pool. Emitting the same event
    // shape used by pg-pool must be handled instead of throwing from EventEmitter.
    expect(() => pool.emit('error', Object.assign(new Error('restart'), { code: '57P01' }))).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      '[db] idle PostgreSQL client disconnected',
      'code=57P01',
      'restart',
    );

    await pool.end();
  });
});
