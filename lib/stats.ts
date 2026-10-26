import { tableCsv } from "./csv";

export interface PromptStat {
  prompt_id: string;
  text: string;
  position: number;
  found_count: number;
  rejected_count: number;
  rejection_rate: number;
}

export interface PersonStat {
  name: string;
  connections: number;
  times_confirmed_for_others: number;
}

export interface SessionStats {
  participation: {
    joined: number;
    active: number;
    submitted: number;
    full_cards: number;
    participation_rate: number;
  };
  squares: {
    confirmed: number;
    rejected: number;
    expired: number;
    avg_confirmed_per_player: number;
    median_confirmed_per_player: number;
    distribution: { label: string; players: number }[];
  };
  timing: {
    avg_elapsed_seconds: number | null;
    median_elapsed_seconds: number | null;
    fastest_full_card: { name: string; seconds: number } | null;
  };
  prompts: PromptStat[];
  people: { top_connected: PersonStat[]; total_unique_connections: number };
}

/** 0.4567 -> "45.7%"; whole numbers drop the decimal. */
export function formatPercent(rate: number): string {
  const p = Math.round(rate * 1000) / 10;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}

/** Seconds -> "m:ss" (or "h:mm:ss"); null -> an em dash. */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const t = Math.max(0, Math.round(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Bar width as a percentage of the max, with a tiny floor so non-zero values stay visible. */
export function barPercent(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.min(100, Math.max(2, (value / max) * 100));
}

/**
 * Marks the n most- and n least-found prompts. Input must be sorted by found_count desc.
 * When the groups would overlap, the top gets priority and the bottom takes what is left.
 */
export function highlightPrompts<T>(sorted: T[], n = 5): ("top" | "bottom" | null)[] {
  const top = Math.min(n, sorted.length);
  const bottom = Math.min(n, sorted.length - top);
  return sorted.map((_, i) => (i < top ? "top" : i >= sorted.length - bottom ? "bottom" : null));
}

export function promptsCsv(prompts: PromptStat[]): string {
  return tableCsv(
    ["Prompt", "Found (confirmed)", "Rejected", "Rejection rate"],
    prompts.map((p) => [p.text, p.found_count, p.rejected_count, formatPercent(p.rejection_rate)]),
  );
}

export function peopleCsv(people: PersonStat[]): string {
  return tableCsv(
    ["Rank", "Name", "Coworkers met", "Times confirmed for others"],
    people.map((p, i) => [i + 1, p.name, p.connections, p.times_confirmed_for_others]),
  );
}
