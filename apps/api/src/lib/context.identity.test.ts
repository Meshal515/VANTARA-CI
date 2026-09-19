import { describe, expect, it, vi } from 'vitest';
import { mintIdentityToken } from '@vantara/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireSession, type AppContext } from './context.ts';
import type { Session } from './sessions.ts';

const SECRET = 'identity-secret-shared-with-worker-for-test';

function requestWithBearer(token: string): FastifyRequest {
  return {
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
  } as unknown as FastifyRequest;
}

function replyRecorder(): {
  reply: FastifyReply;
  status: () => number | null;
  body: () => unknown;
} {
  let statusCode: number | null = null;
  let sentBody: unknown;
  const reply = {
    code(code: number) {
      statusCode = code;
      return this;
    },
    async send(body: unknown) {
      sentBody = body;
      return this;
    },
    clearCookie() {
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, status: () => statusCode, body: () => sentBody };
}

function context(resolveIdentity: (identityId: string, deviceId: string) => Promise<Session | undefined>) {
  return {
    config: { VANTARA_IDENTITY_SECRET: SECRET },
    sessions: { resolveIdentity },
  } as unknown as AppContext;
}

describe('B2 Content API VANTARA bearer identity', () => {
  it('verifies the Worker token and resolves the same identity and device', async () => {
    const userId = 'vantara-user-1';
    const deviceId = 'device-0001';
    const token = await mintIdentityToken({ userId, deviceId }, SECRET);
    const expectedSession: Session = {
      id: `identity:${userId}:${deviceId}`,
      identityId: userId,
      userId: 'uchiyomi-user-1',
      username: 'meshal',
      token: 'server-only-upstream-token',
    };
    const resolveIdentity = vi.fn(async () => expectedSession);
    const ctx = context(resolveIdentity);
    const request = requestWithBearer(token);
    const recorder = replyRecorder();

    await requireSession(ctx)(request, recorder.reply);

    expect(resolveIdentity).toHaveBeenCalledOnce();
    expect(resolveIdentity).toHaveBeenCalledWith(userId, deviceId);
    expect(request.session).toEqual(expectedSession);
    expect(recorder.status()).toBeNull();
  });

  it('rejects a valid identity token when the identity has no Uchiyomi link', async () => {
    const token = await mintIdentityToken(
      { userId: 'unlinked-vantara-user', deviceId: 'device-0001' },
      SECRET,
    );
    const resolveIdentity = vi.fn(async () => undefined);
    const ctx = context(resolveIdentity);
    const request = requestWithBearer(token);
    const recorder = replyRecorder();

    await requireSession(ctx)(request, recorder.reply);

    expect(resolveIdentity).toHaveBeenCalledOnce();
    expect(request.session).toBeUndefined();
    expect(recorder.status()).toBe(401);
    expect(recorder.body()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a forged bearer before consulting the identity link store', async () => {
    const resolveIdentity = vi.fn(async () => undefined);
    const ctx = context(resolveIdentity);
    const request = requestWithBearer('forged.token');
    const recorder = replyRecorder();

    await requireSession(ctx)(request, recorder.reply);

    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(recorder.status()).toBe(401);
    expect(recorder.body()).toEqual({ error: 'unauthorized' });
  });
});
