import { describe, expect, it, vi } from 'vitest';
import { UchiyomiClient } from './client.ts';

describe('UchiyomiClient retry safety', () => {
  it('does not retry token minting after an ambiguous network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      // Simulates the dangerous case: upstream may have committed the POST,
      // then the response connection disappeared before VANTARA received it.
      throw new TypeError('socket closed after write');
    }) as unknown as typeof fetch;

    const client = new UchiyomiClient({
      baseUrl: 'http://uchiyomi.test',
      retries: 2,
      fetchImpl,
    });

    await expect(
      client.mintToken('session-token', {
        name: 'vantara test',
        scopes: ['read', 'write'],
        expiresInDays: 1,
      }),
    ).rejects.toThrow('socket closed after write');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
