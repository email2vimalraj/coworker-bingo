/** Code alphabet: digits 2-9 and letters except I, L, O (no 0/O/1/I/L). */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const ALPHABET_RE = new RegExp(`^[${CODE_ALPHABET}]+$`);

/** Uppercase, trim, and keep only letters/digits. */
function clean(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Extracts a code from raw input: a bare code, a code with/without dash,
 * or a URL containing `c=<code>` (everything else is stripped).
 * Mirrors the SQL function normalize_player_code (the DB also accepts URLs,
 * so the client may pass raw scanner output straight through).
 */
function extract(input: string): string {
  const m = /[?&]c=([^&#\s]+)/i.exec(input);
  return clean(m ? m[1] : input);
}

/** Normalizes a player code to `XXX-XXX`, or null if it can't be valid. */
export function normalizePlayerCode(input: string): string | null {
  const c = extract(input ?? "");
  if (c.length !== 6 || !ALPHABET_RE.test(c)) return null;
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}

/** Normalizes a session code to 6 uppercase chars, or null. Accepts a /join/CODE or /play/CODE URL. */
export function normalizeSessionCode(input: string): string | null {
  const raw = input ?? "";
  const m = /\/(?:join|play)\/([A-Za-z0-9]+)/.exec(raw);
  const c = clean(m ? m[1] : raw);
  if (c.length !== 6 || !ALPHABET_RE.test(c)) return null;
  return c;
}

export function isValidPlayerCode(input: string): boolean {
  return normalizePlayerCode(input) !== null;
}

/** URL encoded in a player's QR code. */
export function playerQrUrl(origin: string, sessionCode: string, playerCode: string): string {
  return `${origin}/play/${sessionCode}/scan?c=${playerCode}`;
}

/** URL encoded in the session's join QR code. */
export function joinUrl(origin: string, sessionCode: string): string {
  return `${origin}/join/${sessionCode}`;
}
