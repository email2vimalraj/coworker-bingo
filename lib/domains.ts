/** Allowed email domain helpers (mirrors _normalize_domains / join_session in migration 0003). */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const MAX_DOMAINS = 20;

/** Splits a comma/space/newline separated list; lowercases and dedupes. Entries that aren't plain domains go to `invalid`. */
export function parseDomains(input: string): { domains: string[]; invalid: string[] } {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const d = raw.trim().toLowerCase();
    if (!d) continue;
    if (d.length > 253 || !DOMAIN_RE.test(d)) {
      if (!invalid.includes(raw.trim())) invalid.push(raw.trim());
    } else if (!domains.includes(d)) {
      domains.push(d);
    }
  }
  return { domains, invalid };
}

/** True if `allowed` is empty (any domain) or the email's domain exactly equals one entry. */
export function emailDomainAllowed(email: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 0) return false;
  return allowed.includes(e.slice(at + 1));
}

/** "@acme.com" or "@acme.com or @acme.co.uk" */
export function describeDomains(domains: string[]): string {
  return domains.map((d) => `@${d}`).join(" or ");
}
