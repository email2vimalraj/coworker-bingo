import type { LeaderboardRow } from "./supabase/types";
import { formatDuration } from "./useCountdown";

export function cell(v: string | number | boolean | null): string {
  let s = v === null ? "" : String(v);
  // Guard against spreadsheet formula injection from player-entered text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function leaderboardCsv(rows: LeaderboardRow[], showLines = false): string {
  const header = [
    "Rank",
    "Name",
    "Email",
    ...(showLines ? ["Lines", "Reach time (mm:ss)"] : []),
    "Correct",
    "Time (mm:ss)",
    "Submitted at",
    "Eligible to win",
    "Winner",
    "Prize rank",
  ];
  const lines = rows.map((r) =>
    [
      r.rank,
      r.full_name,
      r.email,
      ...(showLines ? [r.lines, r.reach_seconds === null ? null : formatDuration(r.reach_seconds)] : []),
      r.correct,
      formatDuration(r.elapsed_seconds),
      r.submitted_at,
      r.eligible ? "yes" : "no",
      r.is_winner ? "yes" : "no",
      r.prize_rank,
    ]
      .map(cell)
      .join(","),
  );
  return [header.map(cell).join(","), ...lines].join("\r\n");
}

/** Generic table to CSV (same escaping as the leaderboard export). */
export function tableCsv(header: string[], rows: (string | number | boolean | null)[][]): string {
  return [header.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
