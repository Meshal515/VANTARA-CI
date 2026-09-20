import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter(Boolean);

const isBackendPath = (path) =>
  path === '.env.example' ||
  path === 'package.json' ||
  path === 'pnpm-lock.yaml' ||
  path === 'pnpm-workspace.yaml' ||
  path === 'tsconfig.base.json' ||
  path === 'vitest.config.ts' ||
  path === '.github/workflows/ci.yml' ||
  path.startsWith('apps/api/') ||
  path.startsWith('packages/db/') ||
  path.startsWith('packages/domain/') ||
  path.startsWith('packages/uchiyomi/') ||
  path.startsWith('services/sync-worker/') ||
  path.startsWith('services/translation-worker/') ||
  path.startsWith('infra/') ||
  path.startsWith('tools/backend-public-safety.test.mjs');

const backendFiles = tracked.filter(isBackendPath);

const readText = (path) => {
  const full = join(root, path);
  if (!existsSync(full)) return '';
  const value = readFileSync(full);
  if (value.includes(0)) return '';
  return value.toString('utf8');
};

test('public backend mirror tracks no secret-bearing filenames', () => {
  const bad = tracked.filter((path) => {
    const base = path.split('/').at(-1) ?? '';
    if (base === '.env.example') return false;
    if (base === '.env' || base.startsWith('.env.')) return true;
    if (base === '.dev.vars' || base === 'id_rsa' || base === 'id_ed25519') return true;
    if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(base)) return true;
    if (/^(?:credentials|service-account)(?:\.[^.]+)?\.json$/i.test(base)) return true;
    return false;
  });
  assert.deepEqual(bad, []);
});

test('public backend mirror contains no high-confidence credential literals', () => {
  const patterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
    ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
    ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
    ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
    ['Stripe live key', /\bsk_live_[A-Za-z0-9]{16,}\b/g],
  ];

  const findings = [];
  for (const path of backendFiles) {
    const text = readText(path);
    for (const [name, pattern] of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) findings.push(`${path}: ${name}`);
    }

    const isTestFixture = path.includes('/tests/') || path.includes('/test/') || path.includes('.test.');
    if (!isTestFixture) {
      const assignment = /\\b(SESSION_SECRET|VANTARA_IDENTITY_SECRET|VANTARA_DEVICE_PEPPER|POSTGRES_PASSWORD|TEST_PASSWORD|TUNNEL_TOKEN|CLOUDFLARE_API_TOKEN)\\b\\s*[:=]\\s*["']([^"'\\n]{12,})["']/g;
      let match;
      while ((match = assignment.exec(text)) !== null) {
        const value = match[2];
        if (value.includes('${')) continue;
        if (/(?:^|[-_])(test|testing|ci|dummy|example|placeholder)(?:[-_]|$)|change-me|__|localhost/i.test(value)) continue;
        findings.push(`${path}: literal ${match[1]}`);
      }
    }
  }
  assert.deepEqual(findings, []);
});

test('production credential scan cannot parse a leading-hyphen signature as an option', () => {
  const workflow = readText('.github/workflows/ci.yml');
  const start = workflow.indexOf('Scan production source for credential signatures');
  const end = workflow.indexOf('\n      - ', start + 1);
  assert.ok(start >= 0, 'missing production credential scan step');
  const step = workflow.slice(start, end > start ? end : undefined);

  // The private-key signature begins with hyphens. Without -e/--regexp, git
  // parses it as an option, exits with an error, and an `if git grep ...`
  // silently treats that error exactly like "no credentials found".
  assert.match(
    step,
    /git grep[^\n]*\s-e\s+['"]-----BEGIN /,
    'credential signature must be passed with -e so a scan error cannot masquerade as clean',
  );
});

test('public CI uses no repository secrets and cannot deploy', () => {
  const workflow = readText('.github/workflows/ci.yml');
  assert.ok(workflow.length > 0, 'missing public CI workflow');
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /\bwrangler\s+deploy\b/i);
  assert.doesNotMatch(workflow, /cloudflare\/pages-action|pages deploy|docker\s+push/i);

  const workflows = tracked.filter((path) => path.startsWith('.github/workflows/'));
  assert.deepEqual(workflows, ['.github/workflows/ci.yml']);
});

test('Cloudflare D1 binding stays a placeholder in the public mirror', () => {
  const wrangler = readText('services/sync-worker/wrangler.toml');
  assert.match(wrangler, /database_id\s*=\s*"__D1_DATABASE_ID__"/);
  assert.doesNotMatch(wrangler, /database_id\s*=\s*"[0-9a-f]{32,}"/i);
});

test('D1 migration numbers are unique, ordered, and include the top collection closure migration', () => {
  const dir = join(root, 'services/sync-worker/migrations');
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();

  const numbers = files.map((name) => Number(name.slice(0, 4)));
  assert.equal(new Set(numbers).size, numbers.length, 'duplicate migration number');
  for (let i = 1; i < numbers.length; i += 1) {
    assert.ok(numbers[i] > numbers[i - 1], `migration order regressed: ${files[i - 1]} -> ${files[i]}`);
  }
  assert.ok(files.includes('0011_top_collection.sql'));
});


test('live D1 verifier exercises trusted-device v2 without touching real accounts', () => {
  const verify = readText('services/sync-worker/verify.mjs');
  assert.match(verify, /USERNAME = '__verify__'/);
  assert.match(verify, /\/v1\/device\/pair/);
  assert.match(verify, /deviceCredential/);
  assert.match(verify, /device_proof_required/);
  assert.match(verify, /\/v1\/device\/logout-all/);
  assert.match(verify, /--cleanup-only/);
  assert.match(verify, /DELETE FROM accounts WHERE user_id = \?/);
});
