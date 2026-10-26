/** Prompt pool rules, mirrored from create_session / update_session in SQL. */
export const MIN_PROMPTS = 24;
export const MAX_PROMPTS = 200;
export const MAX_PROMPT_LENGTH = 120;
/** Prompts on each player's board (the 5x5 grid minus the FREE centre). */
export const BOARD_PROMPTS = 24;

const key = (p: string) => p.trim().toLowerCase();

/** Indexes of prompts that repeat an earlier-or-later one (case-insensitive, trimmed). Blanks are ignored. */
export function duplicateIndexes(prompts: string[]): Set<number> {
  const seen = new Map<string, number[]>();
  prompts.forEach((p, i) => {
    const k = key(p);
    if (!k) return;
    seen.set(k, [...(seen.get(k) ?? []), i]);
  });
  const out = new Set<number>();
  for (const idx of seen.values()) if (idx.length > 1) idx.forEach((i) => out.add(i));
  return out;
}

/** Splits pasted text into prompts, one per line: trims, drops blanks and repeats within the paste. */
export function parsePromptLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || seen.has(key(t))) continue;
    seen.add(key(t));
    out.push(t);
  }
  return out;
}

/** Appends new prompts to the list, skipping ones already present. Fills blank rows first. Caps at MAX_PROMPTS. */
export function appendPrompts(existing: string[], incoming: string[]): { list: string[]; added: number; skipped: number } {
  const have = new Set(existing.map(key).filter(Boolean));
  const list = [...existing];
  let added = 0;
  let skipped = 0;
  for (const raw of incoming) {
    const t = raw.trim();
    if (!t || have.has(key(t))) {
      skipped++;
      continue;
    }
    const blank = list.findIndex((p) => !p.trim());
    if (blank >= 0) list[blank] = t;
    else if (list.length < MAX_PROMPTS) list.push(t);
    else {
      skipped++;
      continue;
    }
    have.add(key(t));
    added++;
  }
  return { list, added, skipped };
}

/** Problems with a prompt list, as messages for the admin. Empty when it is valid. */
export function promptProblems(prompts: string[]): string[] {
  const out: string[] = [];
  const trimmed = prompts.map((p) => p.trim());
  if (prompts.length < MIN_PROMPTS) out.push(`Add at least ${MIN_PROMPTS} prompts (you have ${prompts.length}).`);
  if (prompts.length > MAX_PROMPTS) out.push(`At most ${MAX_PROMPTS} prompts (you have ${prompts.length}).`);
  if (trimmed.some((p) => !p)) out.push("Fill in or remove the empty prompts.");
  if (trimmed.some((p) => p.length > MAX_PROMPT_LENGTH)) out.push(`Prompts can be at most ${MAX_PROMPT_LENGTH} characters.`);
  if (duplicateIndexes(prompts).size) out.push("Prompts must all be different (see the highlighted rows).");
  return out;
}
