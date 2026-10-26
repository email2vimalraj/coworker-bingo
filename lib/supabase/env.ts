/**
 * Supabase connection settings. The publishable key (sb_publishable_...) replaces the legacy
 * anon key; the old variable name still works as a fallback. Both are safe to expose in the browser.
 * (Written as literal process.env reads so Next.js inlines them into client bundles.)
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const MISSING_ENV_MESSAGE =
  "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";
