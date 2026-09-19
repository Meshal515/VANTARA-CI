/**
 * مُشغّل migrations بسيط ومتعمَّد البساطة.
 *
 * كل ملف .sql في migrations/ يُطبّق مرة واحدة، بالترتيب الأبجدي، داخل transaction،
 * وتُسجّل بصمته. تغيير ملف مُطبَّق سابقًا = خطأ صريح، لا تطبيق صامت.
 *
 *   node --experimental-strip-types src/migrate.ts [--dry]
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const LEDGER = `
CREATE TABLE IF NOT EXISTS vantara_migrations (
  name        text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
)`;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  connectionString: string,
  opts: { dryRun?: boolean; log?: (msg: string) => void } = {},
): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const client = new pg.Client({ connectionString });
  await client.connect();

  const result: MigrateResult = { applied: [], skipped: [] };

  try {
    await client.query(LEDGER);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM vantara_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const name of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
      const checksum = sha256(sql);
      const previous = done.get(name);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `migration ${name} changed after being applied — ` +
              `add a new migration instead of editing this one`,
          );
        }
        result.skipped.push(name);
        continue;
      }

      if (opts.dryRun) {
        log(`would apply ${name}`);
        result.applied.push(name);
        continue;
      }

      // كل migration ذرّية: إما تُطبّق كاملة وتُسجّل، أو لا شيء
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO vantara_migrations (name, checksum) VALUES ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err });
      }

      log(`applied ${name}`);
      result.applied.push(name);
    }
  } finally {
    await client.end();
  }

  return result;
}

// تشغيل مباشر من سطر الأوامر (وليس استيرادًا من اختبار أو من الـAPI)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const res = await migrate(url, {
    dryRun: process.argv.includes('--dry'),
    log: (m) => console.log(m),
  });
  console.log(`done — ${res.applied.length} applied, ${res.skipped.length} already current`);
}
