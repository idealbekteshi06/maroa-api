/**
 * lib/i18n.ts
 * ---------------------------------------------------------------------------
 * i18n scaffold — Audit 2026-05-19 F30.
 *
 * Maroa's product supports 18 languages but the marketing site is
 * English-only. A full i18n rollout (string extraction, translation
 * workflow, locale-aware routing) is a multi-week epic. This file is the
 * single source of truth for what we WILL support so we can:
 *
 *   1. Generate correct hreflang alternates from page metadata today,
 *      preserving SEO authority when real locale pages land.
 *   2. Drop English-only `messages.json`-style files into each locale
 *      folder later without re-plumbing every page.
 *
 * The locale list mirrors the product's supported set per CLAUDE.md
 * (EN, ES, FR, DE, IT, PT, NL, SE, NO, DK, FI, PL, TR, AR, JA, KO, ZH, SQ).
 * `en` is the default. Albanian (sq) is the highest-priority second
 * locale given the Tirana HQ + initial customer base.
 * ---------------------------------------------------------------------------
 */

export const DEFAULT_LOCALE = 'en';

export const SUPPORTED_LOCALES = [
  'en',
  'sq', // Albanian — Tirana HQ + initial customer cohort
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'nl',
  'sv',
  'no',
  'da',
  'fi',
  'pl',
  'tr',
  'ar',
  'ja',
  'ko',
  'zh',
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Active locales — pages that have been translated. Until per-locale
 * pages exist under `app/[locale]/`, this stays at ['en']. Add a locale
 * here ONLY after its translated pages are live; including a locale that
 * 404s in hreflang is worse than not listing it.
 */
export const ACTIVE_LOCALES: Locale[] = ['en'];

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://maroa.ai';

/**
 * Build the `metadata.alternates.languages` map for a given canonical
 * path. Today this only emits `en` (since that's all that ships). When a
 * locale is added to ACTIVE_LOCALES, alternates auto-include it on every
 * page that uses this helper — no per-page edits needed.
 *
 * Usage in a page's metadata export:
 *
 *   export const metadata: Metadata = {
 *     alternates: {
 *       canonical: '/pricing',
 *       languages: hreflangAlternates('/pricing'),
 *     },
 *   };
 */
export function hreflangAlternates(canonicalPath: string): Record<string, string> {
  const path = canonicalPath.startsWith('/') ? canonicalPath : `/${canonicalPath}`;
  const map: Record<string, string> = {
    'x-default': `${SITE_URL}${path}`,
  };
  for (const locale of ACTIVE_LOCALES) {
    map[locale] =
      locale === DEFAULT_LOCALE
        ? `${SITE_URL}${path}`
        : `${SITE_URL}/${locale}${path}`;
  }
  return map;
}

/**
 * Future-friendly path builder — once /[locale]/ pages land, callers
 * (e.g., the marketing nav) can swap hardcoded /pricing for
 * `localePath('/pricing', locale)`.
 */
export function localePath(path: string, locale: Locale = DEFAULT_LOCALE): string {
  const safe = path.startsWith('/') ? path : `/${path}`;
  if (locale === DEFAULT_LOCALE) return safe;
  return `/${locale}${safe}`;
}
