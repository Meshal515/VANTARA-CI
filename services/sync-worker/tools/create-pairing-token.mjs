import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 60 * 60_000;

function requireSecret(value, label) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function createPairingRecord({
  token,
  pepper,
  userId = null,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
}) {
  requireSecret(token, 'pairing_token');
  requireSecret(pepper, 'device_pepper');
  if (userId !== null && (typeof userId !== 'string' || userId.length === 0 || userId.length > 256)) {
    throw new Error('user_id_invalid');
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('now_invalid');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    throw new Error('ttl_invalid');
  }

  return {
    token,
    tokenHash: createHmac('sha256', pepper).update(token).digest('hex'),
    userId,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
}

export function buildPairingInsertSql(record) {
  const user = record.userId === null ? 'NULL' : sqlString(record.userId);
  return [
    'INSERT INTO pairing_tokens (token_hash, user_id, expires_at, consumed_at, created_at)',
    `VALUES (${sqlString(record.tokenHash)}, ${user}, ${Number(record.expiresAt)}, NULL, ${Number(record.createdAt)});`,
  ].join(' ');
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag}_requires_value`);
  return value;
}

export function parseCli(args, env = process.env) {
  const userId = valueAfter(args, '--user') ?? null;
  const database = valueAfter(args, '--database') ?? env.D1_NAME ?? 'vantara';
  const ttlText = valueAfter(args, '--ttl-minutes');
  const ttlMinutes = ttlText === undefined ? 10 : Number(ttlText);
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 60) {
    throw new Error('ttl_minutes_invalid');
  }
  const pepper = requireSecret(env.VANTARA_DEVICE_PEPPER, 'device_pepper');
  return { userId, database, ttlMs: Math.round(ttlMinutes * 60_000), pepper };
}

export function provisionPairingToken({
  args = process.argv.slice(2),
  env = process.env,
  now = Date.now(),
  run = spawnSync,
} = {}) {
  const options = parseCli(args, env);
  const token = randomBytes(32).toString('base64url');
  const record = createPairingRecord({
    token,
    pepper: options.pepper,
    userId: options.userId,
    now,
    ttlMs: options.ttlMs,
  });
  const sql = buildPairingInsertSql(record);
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = run(
    'npx',
    ['--yes', 'wrangler@4', 'd1', 'execute', options.database, '--remote', '--command', sql],
    { cwd: packageDir, stdio: 'inherit', env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler_failed_${String(result.status)}`);
  return record;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const record = provisionPairingToken();
    console.log('');
    console.log('Pairing token (shown once):');
    console.log(record.token);
    console.log('');
    console.log('APK link:');
    console.log(`vantara://pair?pair=${encodeURIComponent(record.token)}`);
    console.log('');
    console.log(`Expires: ${new Date(record.expiresAt).toISOString()}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
