import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as domain from '@vantara/domain';
import * as library from './library.ts';
import * as sources from './sources.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const execFileAsync = promisify(execFile);

describe('B6 source and chapter contract', () => {
  it('keeps the browser shell syntactically valid', async () => {
    const file = join(ROOT, 'apps/web/app.js');
    await expect(execFileAsync(process.execPath, ['--check', file])).resolves.toBeDefined();
  });

  it('exposes a stable user-facing source contract instead of raw verdict jargon', () => {
    const toPublicSource = (domain as Record<string, unknown>)['toPublicSource'];
    expect(typeof toPublicSource).toBe('function');
    if (typeof toPublicSource !== 'function') return;

    const source = toPublicSource({
      id: 'arabic-source',
      name: 'Arabic Source',
      lang: 'ar',
      verdict: 'SUPPORTED',
    }) as Record<string, unknown>;

    expect(source).toEqual({
      id: 'arabic-source',
      name: 'Arabic Source',
      language: 'ar',
      health: 'healthy',
      capabilities: { search: true, read: true },
    });
    expect(source).not.toHaveProperty('verdict');
  });

  it('uses the public source id and language names in the web adapter', async () => {
    const web = await readFile(join(ROOT, 'apps/web/app.js'), 'utf8');
    expect(web).toContain('state.sources.set(source.id, source)');
    expect(web).not.toContain('state.sources.set(source.sourceId, source)');
    expect(web).toContain('state.sources.get(provider.source)');
    expect(web).toContain("const lang = source?.language ?? ''");
    expect(web).not.toMatch(/state\.sources\.get\(provider\.source\)\?\.lang(?!uage)/);
  });

  it('ranks search providers on the backend so clients do not reimplement source preference', async () => {
    const rankProvidersByLanguage = (sources as Record<string, unknown>)['rankProvidersByLanguage'];
    expect(typeof rankProvidersByLanguage).toBe('function');
    if (typeof rankProvidersByLanguage !== 'function') return;

    const rank = rankProvidersByLanguage as (
      providers: Array<{ source: string; sourceId: string }>,
      sourceLanguages: ReadonlyMap<string, string | null>,
    ) => Array<{ source: string; sourceId: string }>;

    const ranked = rank(
      [
        { source: 'jp', sourceId: '1' },
        { source: 'en', sourceId: '2' },
        { source: 'ar', sourceId: '3' },
      ],
      new Map([
        ['jp', 'ja'],
        ['en', 'en'],
        ['ar', 'ar'],
      ]),
    );

    expect(ranked.map((provider) => provider.source)).toEqual(['ar', 'en', 'jp']);

    const web = await readFile(join(ROOT, 'apps/web/app.js'), 'utf8');
    expect(web).not.toContain('const LANG_RANK');
    expect(web).not.toContain('function providerRank');
    expect(web).not.toContain('providerRank(a) - providerRank(b)');
  });

  it('does not expose source/fallback diagnostics as chapter UI states', async () => {
    const web = await readFile(join(ROOT, 'apps/web/app.js'), 'utf8');
    expect(web).not.toContain("BLOCKED: 'محجوب'");
    expect(web).not.toContain("HELD: 'مُنتظر'");
    expect(web).not.toContain("BELOW_FLOOR: 'دون الأرضية'");
    expect(web).not.toContain('${chapter.copies.length} مصادر');
    expect(web).not.toContain('لا يعرضها أي مصدر');
    expect(web).toContain("'غير متاح'");
    expect(web).toContain('غير متاح حاليًا');
  });

  it('keeps fallback and readiness polling on the backend so the client fetches once', async () => {
    const web = await readFile(join(ROOT, 'apps/web/app.js'), 'utf8');
    expect(web).not.toContain('const failedCopies = new Set()');
    expect(web).not.toContain('for (let attempt = 0; attempt < 3; attempt += 1)');
    expect(web).not.toContain('for (const waitMs of [400, 900, 1800])');
    expect(web).toContain('bookId = result?.bookId ?? null');
  });

  it('tracks reader chapters by CatalogueEntry.bookId rather than a nonexistent id', async () => {
    const web = await readFile(join(ROOT, 'apps/web/app.js'), 'utf8');
    expect(web).toContain('catalogue.find((c) => c.bookId === id)');
    expect(web).not.toContain('catalogue.find((c) => c.id === id)');
  });

  it('distinguishes an empty source registry from a populated registry with zero SUPPORTED sources', () => {
    const sourceSearchPolicy = (sources as Record<string, unknown>)['sourceSearchPolicy'];
    expect(typeof sourceSearchPolicy).toBe('function');
    if (typeof sourceSearchPolicy !== 'function') return;

    const empty = (sourceSearchPolicy as Function)([]);
    expect(empty.filterSources).toBe(false);
    expect([...empty.allowedSources]).toEqual([]);

    const unverifiedOnly = (sourceSearchPolicy as Function)([
      { source_id: 'unverified-ar', lang: 'ar', verdict: 'REGISTERED_NOT_TESTED' },
      { source_id: 'broken-en', lang: 'en', verdict: 'PARSER_FAILED' },
    ]);
    expect(unverifiedOnly.filterSources).toBe(true);
    expect([...unverifiedOnly.allowedSources]).toEqual([]);

    const withSupported = (sourceSearchPolicy as Function)([
      { source_id: 'ok-ar', lang: 'ar', verdict: 'SUPPORTED' },
      { source_id: 'broken-en', lang: 'en', verdict: 'PARSER_FAILED' },
    ]);
    expect(withSupported.filterSources).toBe(true);
    expect([...withSupported.allowedSources]).toEqual(['ok-ar']);
    expect(withSupported.sourceLanguages.get('ok-ar')).toBe('ar');
  });

  it('maps VANTARA series refs to exact source identities before search policy filtering', async () => {
    const sourceIdentity = (sources as Record<string, unknown>)['sourceIdentity'];
    const sourceKeysForSeriesRefs = (sources as Record<string, unknown>)['sourceKeysForSeriesRefs'];
    expect(typeof sourceIdentity).toBe('function');
    expect(typeof sourceKeysForSeriesRefs).toBe('function');
    if (typeof sourceIdentity !== 'function' || typeof sourceKeysForSeriesRefs !== 'function') return;

    const loadSeries = async (seriesRef: string) => {
      expect(seriesRef).toBe('uchiyomi-series-42');
      return {
        id: seriesRef,
        title: 'Nano Machine',
        sources: [
          { sourceId: 'src-a', sourceSeriesId: 'provider-work-99' },
          { sourceId: 'src-b', sourceSeriesId: 'provider-work-7' },
        ],
      };
    };

    const keys = await (sourceKeysForSeriesRefs as Function)(
      ['uchiyomi-series-42'],
      loadSeries,
    );

    expect(keys.has((sourceIdentity as Function)('src-a', 'provider-work-99'))).toBe(true);
    expect(keys.has((sourceIdentity as Function)('src-b', 'provider-work-7'))).toBe(true);
    expect(keys.has((sourceIdentity as Function)('src-a', 'uchiyomi-series-42'))).toBe(false);
  });

  it('does not compare Uchiyomi series_ref directly with provider.sourceId', async () => {
    const route = await readFile(join(ROOT, 'apps/api/src/routes/sources.ts'), 'utf8');
    expect(route).not.toContain('deletedRefs.has(p.sourceId)');
    expect(route).not.toContain('blockedSeries.has(p.sourceId)');
    expect(route).toContain('blockedSeriesSourceKeys');
  });

  it('keeps chapter fallback in a server-side testable function', () => {
    const fetchChapterWithFallback = (library as Record<string, unknown>)[
      'fetchChapterWithFallback'
    ];
    expect(typeof fetchChapterWithFallback).toBe('function');
  });
});
