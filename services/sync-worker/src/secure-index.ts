/**
 * B2 security gate around the legacy sync worker.
 *
 * Publicly exposed auth is v2 only: a trusted device proves possession of a
 * random credential, then receives a 15-minute VANTARA identity token. The
 * old worker implementation stays behind this wrapper temporarily so B2 can
 * replace authentication without rewriting sync semantics in the same patch.
 */

import {
  CORRELATION_HEADER,
  correlationIdFrom,
  mintIdentityToken,
  verifyIdentityToken,
} from '@vantara/domain';
import legacyWorker from './index.ts';
import { bearerFrom, mintToken } from './session.ts';
import type { Env, ExecutionContext } from './types.ts';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const DEFAULT_ORIGINS = [
  'https://localhost',
  'capacitor://localhost',
  'http://localhost:4173',
  'http://localhost:5173',
];

interface PairingRow {
  token_hash: string;
  user_id: string | null;
  expires_at: number;
  consumed_at: number | null;
}

interface AccountRow {
  user_id: string;
  username: string;
  display_name: string | null;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin');
  const allowed = [
    ...DEFAULT_ORIGINS,
    ...(env.ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? []),
  ];
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(
  body: unknown,
  init: ResponseInit = {},
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...extra, ...(init.headers ?? {}) },
  });
}

function validSecretPart(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= max;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** D1 never stores pairing/device credentials themselves. */
export async function hashDeviceSecret(value: string, pepper: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

async function pairDevice(request: Request, env: Env, now: number): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const deviceId = typeof body?.['deviceId'] === 'string' ? body['deviceId'] : '';
  const deviceCredential = body?.['deviceCredential'];
  const pairingToken = body?.['pairingToken'];
  if (
    deviceId.length < 8 ||
    deviceId.length > 128 ||
    !validSecretPart(deviceCredential) ||
    !validSecretPart(pairingToken)
  ) {
    return json({ error: 'bad_request' }, { status: 400 });
  }

  const pairingHash = await hashDeviceSecret(pairingToken, env.VANTARA_DEVICE_PEPPER);
  const pairing = await env.DB.prepare(
    `SELECT token_hash, user_id, expires_at, consumed_at
       FROM pairing_tokens WHERE token_hash = ?`,
  )
    .bind(pairingHash)
    .first<PairingRow>();

  if (!pairing || pairing.consumed_at !== null || pairing.expires_at <= now) {
    return json({ error: 'pairing_invalid' }, { status: 401 });
  }

  // Consume first. If a later write fails the Owner creates a fresh token; we
  // never risk one pairing token being replayed because provisioning failed.
  const consumed = await env.DB.prepare(
    `UPDATE pairing_tokens SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(now, pairingHash, now)
    .run();
  if ((consumed.meta.changes ?? 0) !== 1) {
    return json({ error: 'pairing_invalid' }, { status: 401 });
  }

  const credentialHash = await hashDeviceSecret(deviceCredential, env.VANTARA_DEVICE_PEPPER);
  const accounts = pairing.user_id
    ? [{ user_id: pairing.user_id }]
    : (
        await env.DB.prepare('SELECT user_id FROM accounts ORDER BY created_at')
          .all<{ user_id: string }>()
      ).results;

  if (accounts.length === 0) return json({ error: 'no_accounts' }, { status: 409 });

  await env.DB.batch(
    accounts.map((account) =>
      env.DB.prepare(
        `INSERT INTO trusted_devices
           (device_id, user_id, credential_hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(device_id, user_id) DO UPDATE SET
           credential_hash = excluded.credential_hash,
           last_used_at = excluded.last_used_at,
           revoked_at = NULL`,
      ).bind(deviceId, account.user_id, credentialHash, now, now),
    ),
  );

  return json({ paired: true, accounts: accounts.length });
}

async function issueSession(request: Request, env: Env, now: number): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const userId = typeof body?.['userId'] === 'string' ? body['userId'] : '';
  const deviceId = typeof body?.['deviceId'] === 'string' ? body['deviceId'] : '';
  const deviceCredential = body?.['deviceCredential'];
  if (!userId || deviceId.length < 8 || !validSecretPart(deviceCredential)) {
    return json({ error: 'device_proof_required' }, { status: 401 });
  }

  const credentialHash = await hashDeviceSecret(deviceCredential, env.VANTARA_DEVICE_PEPPER);
  const trusted = await env.DB.prepare(
    `SELECT 1 AS ok FROM trusted_devices
      WHERE device_id = ? AND user_id = ? AND credential_hash = ?
        AND revoked_at IS NULL`,
  )
    .bind(deviceId, userId, credentialHash)
    .first<{ ok: number }>();
  if (!trusted) return json({ error: 'device_untrusted' }, { status: 401 });

  const account = await env.DB.prepare(
    `SELECT a.user_id, a.username, p.display_name
       FROM accounts a LEFT JOIN profiles p USING (user_id)
      WHERE a.user_id = ?`,
  )
    .bind(userId)
    .first<AccountRow>();
  if (!account) return json({ error: 'unknown_account' }, { status: 404 });

  await env.DB.prepare(
    `UPDATE trusted_devices SET last_used_at = ?
      WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL`,
  )
    .bind(now, deviceId, userId)
    .run();

  const token = await mintIdentityToken(
    { userId: account.user_id, deviceId },
    env.VANTARA_IDENTITY_SECRET,
    now,
  );
  return json({
    token,
    user: {
      userId: account.user_id,
      username: account.username,
      displayName: account.display_name ?? account.username,
    },
  });
}

async function requireIdentity(request: Request, env: Env, now: number) {
  const token = bearerFrom(request);
  if (!token) return null;
  return verifyIdentityToken(token, env.VANTARA_IDENTITY_SECRET, now);
}

async function logoutDevice(request: Request, env: Env, now: number): Promise<Response> {
  const claims = await requireIdentity(request, env, now);
  if (!claims) return json({ error: 'unauthorized' }, { status: 401 });
  await env.DB.prepare(
    `UPDATE trusted_devices SET revoked_at = ?
      WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL`,
  )
    .bind(now, claims.deviceId, claims.userId)
    .run();
  return new Response(null, { status: 204 });
}

async function logoutAll(request: Request, env: Env, now: number): Promise<Response> {
  const claims = await requireIdentity(request, env, now);
  if (!claims) return json({ error: 'unauthorized' }, { status: 401 });
  const result = await env.DB.prepare(
    `UPDATE trusted_devices SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL`,
  )
    .bind(now, claims.userId)
    .run();
  return json({ revoked: result.meta.changes ?? 0 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const now = Date.now();
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (path === '/v1/device/pair' && request.method === 'POST') {
        const response = await pairDevice(request, env, now);
        return new Response(response.body, {
          status: response.status,
          headers: { ...JSON_HEADERS, ...cors },
        });
      }
      if (path === '/v1/session' && request.method === 'POST') {
        const response = await issueSession(request, env, now);
        return new Response(response.body, {
          status: response.status,
          headers: { ...JSON_HEADERS, ...cors },
        });
      }
      if (path === '/v1/device/logout' && request.method === 'POST') {
        const response = await logoutDevice(request, env, now);
        return new Response(response.body, { status: response.status, headers: { ...cors } });
      }
      if (path === '/v1/device/logout-all' && request.method === 'POST') {
        const response = await logoutAll(request, env, now);
        return new Response(response.body, {
          status: response.status,
          headers: { ...JSON_HEADERS, ...cors },
        });
      }

      // Health + account chooser stay public exactly as before.
      if (path === '/health' || (path === '/v1/accounts' && request.method === 'GET')) {
        return legacyWorker.fetch(request, env, ctx);
      }

      const claims = await requireIdentity(request, env, now);
      if (!claims) return json({ error: 'unauthorized' }, { status: 401 }, cors);

      // Temporary B2 adapter: old sync handlers receive a legacy token generated
      // inside the Worker. The browser never sees or can mint this token. B3 can
      // delete the adapter after transport/auth migration is complete.
      const internalToken = await mintToken(claims.userId, env.VANTARA_SESSION_SECRET, now);
      const headers = new Headers(request.headers);
      headers.set('authorization', `Bearer ${internalToken}`);
      const delegated = new Request(request, { headers });
      return legacyWorker.fetch(delegated, env, ctx);
    } catch (error) {
      // B10: نفس قاعدة البوابة الأخرى — الرسالة تبقى، والمعرّف يخرج
      const correlationId = correlationIdFrom(request.headers.get(CORRELATION_HEADER));
      console.error(
        'sync-worker secure gate',
        correlationId,
        error instanceof Error ? error.message : error,
      );
      return json({ error: 'internal', correlationId }, { status: 500 }, {
        ...cors,
        [CORRELATION_HEADER]: correlationId,
      });
    }
  },
};
