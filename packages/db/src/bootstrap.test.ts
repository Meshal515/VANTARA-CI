import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function text(path: string): Promise<string> {
  return readFile(join(ROOT, path), 'utf8');
}

describe('B1 clean-install invariants', () => {
  it('bootstraps the separate Uchiyomi database during first Postgres init', async () => {
    const compose = await text('infra/docker-compose.yml');
    const init = await text('infra/postgres-init/10-create-uchiyomi.sh');

    expect(compose).toContain('UCHIYOMI_DB: ${UCHIYOMI_DB:-uchiyomi}');
    expect(compose).toContain('./postgres-init:/docker-entrypoint-initdb.d:ro');
    expect(init).toContain('CREATE DATABASE');
    expect(init).toContain('UCHIYOMI_DB');
    expect(init).toContain('POSTGRES_USER');
  });

  it('runs VANTARA migrations before the API opens its pool or listens', async () => {
    const server = await text('apps/api/src/server.ts');
    const migrateAt = server.indexOf('await migrate(');
    const initPoolAt = server.indexOf('initPool(');
    const listenAt = server.indexOf('app.listen(');

    expect(migrateAt).toBeGreaterThan(-1);
    expect(initPoolAt).toBeGreaterThan(migrateAt);
    expect(listenAt).toBeGreaterThan(initPoolAt);
  });

  it('readiness checks the required VANTARA schema, not only SELECT 1', async () => {
    const app = await text('apps/api/src/app.ts');
    expect(app).toContain("to_regclass('public.vantara_users')");
    expect(app).toContain('schema:');
  });

  it('waits for a healthy Uchiyomi before starting the API', async () => {
    const compose = await text('infra/docker-compose.yml');
    expect(compose).toMatch(/uchiyomi:[\s\S]*?healthcheck:/);
    expect(compose).toContain('uchiyomi: { condition: service_healthy }');
  });

  it('pins optional service images to exact versions instead of floating tags', async () => {
    const compose = await text('infra/docker-compose.yml');
    expect(compose).toContain('cloudflare/cloudflared:2026.9.1');
    expect(compose).toContain('louislam/uptime-kuma:2.5.5');
    expect(compose).toContain('binwiederhier/ntfy:v2.28.0');
    expect(compose).toContain('restic/restic:0.19.1');
    expect(compose).not.toMatch(/(?:latest|uptime-kuma:1)(?:[}\s'"\n]|$)/);
  });

  it('keeps the runbook aligned with logical dumps and includes report attachments', async () => {
    const compose = await text('infra/docker-compose.yml');
    const deploy = await text('docs/DEPLOY.md');

    // B1 moved PostgreSQL backup from a live data-directory snapshot to pg_dump.
    // The operator runbook must not keep pointing restic at the removed mount.
    expect(deploy).not.toContain('restic backup /source/postgres');
    expect(deploy).toContain('/scripts/backup-postgres.sh');
    expect(deploy).toContain('restic backup /backups/postgres /source/api-uploads');

    // Report attachments are non-regenerable user data and DEPLOY promises they are covered.
    expect(compose).toContain('api_uploads:/source/api-uploads:ro');
  });

  it('physically retires the old PostgreSQL social owner after the D1 ownership freeze', async () => {
    const sessions = await text('apps/api/src/lib/sessions.ts');
    const auth = await text('apps/api/src/routes/auth.ts');
    const migration = await text('packages/db/migrations/0006_drop_retired_social.sql');

    // B4 says D1 is the sole owner. Keeping live reads/writes here recreates a
    // second owner even if every HTTP social route has been retired.
    expect(sessions).not.toContain('vantara_profiles');
    expect(sessions).not.toContain('vantara_user_gates');
    expect(auth).not.toContain('vantara_profiles');

    for (const table of [
      'vantara_comment_reactions',
      'vantara_comments',
      'vantara_recommendations',
      'vantara_activity_events',
      'vantara_reading_sessions',
      'vantara_presence',
      'vantara_profiles',
      'vantara_user_gates',
    ]) {
      expect(migration).toMatch(new RegExp(`DROP TABLE(?: IF EXISTS)? ${table}\\b`, 'i'));
    }
  });

  it('backs up PostgreSQL logically instead of snapshotting its live data directory', async () => {
    const compose = await text('infra/docker-compose.yml');
    const backup = await text('infra/backup-postgres.sh');
    const restore = await text('infra/restore-postgres.sh');

    expect(compose).not.toContain('postgres_data:/source/postgres:ro');
    expect(compose).toContain('db-backup:');
    expect(backup).toContain('pg_dump');
    expect(backup).toContain('vantara.dump');
    expect(backup).toContain('uchiyomi.dump');
    expect(restore).toContain('pg_restore');
    expect(restore).toContain('vantara.dump');
    expect(restore).toContain('uchiyomi.dump');
  });
});
