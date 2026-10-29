"use client";
import { useState } from "react";
import Link from "next/link";
import { friendlyError } from "@/lib/errors";
import { DEFAULT_PROMPTS } from "@/lib/defaultPrompts";
import { parseDomains, MAX_DOMAINS } from "@/lib/domains";
import {
  MAX_PROMPTS,
  MIN_PROMPTS,
  appendPrompts,
  duplicateIndexes,
  parsePromptLines,
  promptProblems,
} from "@/lib/promptList";
import type { RankingMode } from "@/lib/ranking";
import { Button, Card, ErrorBox, Field, inputClass } from "@/components/ui";

function pick24(): string[] {
  const bank = [...DEFAULT_PROMPTS];
  for (let i = bank.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bank[i], bank[j]] = [bank[j], bank[i]];
  }
  const out = bank.slice(0, 24);
  while (out.length < 24) out.push("");
  return out;
}

const MODES: { value: RankingMode; title: string; text: string }[] = [
  {
    value: "correct_then_time",
    title: "Most squares, then fastest",
    text: "Whoever confirms the most squares wins. If players tie on squares, the one who submitted sooner ranks higher.",
  },
  {
    value: "lines",
    title: "Bingo lines: first to complete N lines wins",
    text: "Classic bingo. A line is a row, column or diagonal of the board (the FREE centre counts). Whoever completes the chosen number of lines first wins.",
  },
  {
    value: "full_card_fastest",
    title: "First full card wins",
    text: "Only players who complete all 24 squares are ranked, and the fastest full card comes first.",
  },
];

function intIn(v: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

/** Arguments shared by create_session and update_session. */
export interface SessionPayload {
  p_name: string;
  p_duration_seconds: number;
  p_ranking_mode: RankingMode;
  p_require_full_card: boolean;
  p_winners_count: number;
  p_max_squares_per_coworker: number;
  p_allowed_email_domains: string[];
  p_prompts: string[];
  p_lines_to_win: number;
  p_allow_username_claims: boolean;
}

export interface SessionFormValues {
  name: string;
  minutes: string;
  prompts: string[];
  mode: RankingMode;
  fullCard: boolean;
  winners: string;
  maxSquares: string;
  domainsText: string;
  linesToWin: string;
  allowUsername: boolean;
}

export const DEFAULT_FORM_VALUES: SessionFormValues = {
  name: "",
  minutes: "15",
  prompts: DEFAULT_PROMPTS.slice(0, 24).concat(Array(24).fill("")).slice(0, 24),
  mode: "correct_then_time",
  fullCard: false,
  winners: "3",
  maxSquares: "1",
  domainsText: "",
  linesToWin: "1",
  allowUsername: true,
};

export function SessionForm({
  title,
  submitLabel,
  busyLabel,
  backHref,
  backLabel,
  initial = DEFAULT_FORM_VALUES,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  busyLabel: string;
  backHref: string;
  backLabel: string;
  initial?: SessionFormValues;
  /** Perform the save. Throw to show an error; resolve after navigating away. */
  onSubmit: (payload: SessionPayload) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [minutes, setMinutes] = useState(initial.minutes);
  const [prompts, setPrompts] = useState<string[]>(initial.prompts);
  const [mode, setMode] = useState<RankingMode>(initial.mode);
  const [fullCard, setFullCard] = useState(initial.fullCard);
  const [winners, setWinners] = useState(initial.winners);
  const [maxSquares, setMaxSquares] = useState(initial.maxSquares);
  const [domainsText, setDomainsText] = useState(initial.domainsText);
  const [linesToWin, setLinesToWin] = useState(initial.linesToWin);
  const [allowUsername, setAllowUsername] = useState(initial.allowUsername);
  const [errors, setErrors] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const dupes = duplicateIndexes(prompts);

  function addPasted() {
    const r = appendPrompts(prompts, parsePromptLines(pasteText));
    setPrompts(r.list);
    setPasteNote(`Added ${r.added}${r.skipped ? `, skipped ${r.skipped} (blank, duplicate or over ${MAX_PROMPTS})` : ""}.`);
    setPasteText("");
  }

  /** Throws away the current list (including the template prompts) and keeps only the pasted ones. */
  function replaceWithPasted() {
    const r = appendPrompts([], parsePromptLines(pasteText));
    setPrompts(r.list);
    const short = MIN_PROMPTS - r.list.length;
    setPasteNote(
      `Replaced the list with ${r.list.length} pasted prompt${r.list.length === 1 ? "" : "s"}` +
        (r.skipped ? `, skipped ${r.skipped} (duplicate or over ${MAX_PROMPTS})` : "") +
        (short > 0 ? `. Add ${short} more to reach ${MIN_PROMPTS}.` : "."),
    );
    setPasteText("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problems: string[] = [];
    const dur = intIn(minutes, 1, 120);
    const win = intIn(winners, 1, 20);
    const max = intIn(maxSquares, 1, 24);
    if (!name.trim()) problems.push("Give the session a name.");
    else if (name.trim().length > 100) problems.push("The session name is too long (100 characters max).");
    if (dur === null) problems.push("Duration must be a whole number of minutes from 1 to 120.");
    if (win === null) problems.push("Winners must be a whole number from 1 to 20.");
    if (max === null) problems.push("Max squares per coworker must be a whole number from 1 to 24.");
    const lines = intIn(linesToWin, 1, 12);
    if (mode === "lines" && lines === null) problems.push("Lines to win must be a whole number from 1 to 12.");
    const parsedDomains = parseDomains(domainsText);
    if (parsedDomains.invalid.length)
      problems.push(`Not a valid domain (use e.g. acme.com, no @): ${parsedDomains.invalid.join(", ")}`);
    if (parsedDomains.domains.length > MAX_DOMAINS) problems.push(`At most ${MAX_DOMAINS} allowed domains.`);
    const trimmed = prompts.map((p) => p.trim());
    problems.push(...promptProblems(prompts));
    setErrors(problems);
    setServerError(null);
    if (problems.length || dur === null || win === null || max === null) return;

    setBusy(true);
    try {
      await onSubmit({
        p_name: name.trim(),
        p_duration_seconds: dur * 60,
        p_ranking_mode: mode,
        p_require_full_card: fullCard,
        p_winners_count: win,
        p_max_squares_per_coworker: max,
        p_allowed_email_domains: parsedDomains.domains,
        p_prompts: trimmed,
        p_lines_to_win: mode === "lines" && lines !== null ? lines : 1,
        p_allow_username_claims: allowUsername,
      });
    } catch (err) {
      setServerError(friendlyError(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div>
        <Link href={backHref} className="text-sm font-semibold text-accent">
          &larr; {backLabel}
        </Link>
        <h1 className="text-2xl font-extrabold">{title}</h1>
      </div>

      <Card className="space-y-4">
        <Field label="Session name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Summer kickoff" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Duration (minutes)" hint="1 to 120">
            <input className={inputClass} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </Field>
          <Field label="Winners" hint="1 to 20">
            <input className={inputClass} inputMode="numeric" value={winners} onChange={(e) => setWinners(e.target.value)} />
          </Field>
          <Field label="Max squares per coworker" hint="1 to 24. 1 means each coworker can fill only one of your squares.">
            <input className={inputClass} inputMode="numeric" value={maxSquares} onChange={(e) => setMaxSquares(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Allowed email domains (optional)"
          hint="Only players with an email on one of these domains can join. Separate with commas or spaces, e.g. acme.com, acme.co.uk. Leave empty to allow any email."
        >
          <input
            className={inputClass}
            value={domainsText}
            onChange={(e) => setDomainsText(e.target.value)}
            autoCapitalize="none"
            placeholder="acme.com, acme.co.uk"
          />
        </Field>
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border-2 border-slate-200 p-3">
          <input type="checkbox" className="mt-1 h-5 w-5 accent-indigo-600" checked={allowUsername} onChange={(e) => setAllowUsername(e.target.checked)} />
          <span>
            <span className="block font-semibold">Players can fill a square by typing a coworker&apos;s username or email</span>
            <span className="block text-sm text-slate-600">
              When off, players can only scan a QR code or type a player code (like QX7-4PM).
            </span>
          </span>
        </label>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-lg font-bold">How are winners picked?</h2>
        {MODES.map((m) => (
          <label
            key={m.value}
            className={`flex min-h-11 cursor-pointer gap-3 rounded-xl border-2 p-3 ${mode === m.value ? "border-accent bg-indigo-50" : "border-slate-200"}`}
          >
            <input type="radio" name="mode" className="mt-1 h-5 w-5 accent-indigo-600" checked={mode === m.value} onChange={() => setMode(m.value)} />
            <span>
              <span className="block font-semibold">{m.title}</span>
              <span className="block text-sm text-slate-600">{m.text}</span>
            </span>
          </label>
        ))}
        {mode === "lines" ? (
          <Field
            label="Lines to win"
            hint="1 to 12 (5 rows, 5 columns and 2 diagonals; the FREE centre counts). The first players to complete this many lines win."
          >
            <input className={inputClass} inputMode="numeric" value={linesToWin} onChange={(e) => setLinesToWin(e.target.value)} />
          </Field>
        ) : (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border-2 border-slate-200 p-3">
          <input type="checkbox" className="mt-1 h-5 w-5 accent-indigo-600" checked={fullCard} onChange={(e) => setFullCard(e.target.checked)} />
          <span>
            <span className="block font-semibold">Require a full card to win</span>
            <span className="block text-sm text-slate-600">
              Only players with all 24 squares confirmed can win prizes. Everyone still appears on the leaderboard. Players always need at least one confirmed square to win.
            </span>
          </span>
        </label>
        )}
      </Card>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">Prompts ({prompts.length})</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setPrompts(pick24())}>
              Shuffle 24 from bank
            </Button>
            <Button variant="secondary" onClick={() => setPrompts([...DEFAULT_PROMPTS])}>
              Use whole bank ({DEFAULT_PROMPTS.length})
            </Button>
            <Button
              variant="secondary"
              disabled={prompts.length === 0}
              onClick={() => {
                setPrompts([]);
                setPasteOpen(true);
                setPasteNote("List cleared. Paste your prompts below, one per line.");
              }}
            >
              Clear all
            </Button>
          </div>
        </div>
        <p className="text-sm text-slate-600">
          At least {MIN_PROMPTS}. If you add more than {MIN_PROMPTS}, each player gets a random {MIN_PROMPTS}. Players see
          theirs in a random order around a FREE centre square.
        </p>
        <ol className="grid gap-2 sm:grid-cols-2">
          {prompts.map((p, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-7 shrink-0 text-right text-sm font-semibold text-slate-400">{i + 1}</span>
              <input
                className={`${inputClass} ${dupes.has(i) ? "border-red-500 bg-red-50" : ""}`}
                value={p}
                maxLength={120}
                aria-label={`Prompt ${i + 1}`}
                aria-invalid={dupes.has(i) || undefined}
                onChange={(e) => setPrompts((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button
                type="button"
                aria-label={`Remove prompt ${i + 1}`}
                disabled={prompts.length <= MIN_PROMPTS}
                onClick={() => setPrompts((prev) => prev.filter((_, j) => j !== i))}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-300 text-lg font-bold text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                &times;
              </button>
            </li>
          ))}
        </ol>
        {dupes.size ? (
          <p className="text-sm font-semibold text-red-700">
            Repeated prompts (highlighted): rows {[...dupes].map((i) => i + 1).join(", ")}.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={prompts.length >= MAX_PROMPTS}
            onClick={() => setPrompts((prev) => [...prev, ""])}
          >
            Add prompt
          </Button>
          <Button variant="secondary" onClick={() => setPasteOpen((o) => !o)}>
            {pasteOpen ? "Close paste box" : "Paste many"}
          </Button>
        </div>
        {pasteOpen ? (
          <div className="space-y-2">
            <textarea
              className={`${inputClass} min-h-32`}
              rows={6}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              aria-label="Paste prompts, one per line"
              placeholder={"One prompt per line\nHas a pet\nPlays chess"}
            />
            <div className="flex flex-wrap gap-2">
              <Button disabled={!pasteText.trim()} onClick={replaceWithPasted}>
                Replace all with pasted
              </Button>
              <Button variant="secondary" disabled={!pasteText.trim()} onClick={addPasted}>
                Add to current list
              </Button>
            </div>
            {pasteNote ? <p className="text-sm text-slate-600">{pasteNote}</p> : null}
          </div>
        ) : null}
      </Card>

      {errors.length ? (
        <ErrorBox>
          <ul className="list-disc pl-5">
            {errors.map((er) => (
              <li key={er}>{er}</li>
            ))}
          </ul>
        </ErrorBox>
      ) : null}
      {serverError ? <ErrorBox>{serverError}</ErrorBox> : null}
      <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
        {busy ? busyLabel : submitLabel}
      </Button>
    </form>
  );
}
