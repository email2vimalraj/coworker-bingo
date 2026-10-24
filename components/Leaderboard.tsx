import { ordinal } from "@/lib/format";
import { formatDuration } from "@/lib/useCountdown";
import type { LeaderboardRow } from "@/lib/supabase/types";

export function Leaderboard({
  rows,
  showEmail = true,
  big = false,
}: {
  rows: LeaderboardRow[];
  showEmail?: boolean;
  big?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="p-4 text-slate-500">No players yet.</p>;
  }
  const text = big ? "text-2xl" : "text-sm";
  const pad = big ? "px-4 py-3" : "px-3 py-2";
  return (
    <div className="overflow-x-auto">
      <table className={`w-full min-w-[34rem] border-collapse text-left ${text}`}>
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <th className={pad}>Rank</th>
            <th className={pad}>Name</th>
            {showEmail ? <th className={pad}>Email</th> : null}
            <th className={pad}>Correct</th>
            <th className={pad}>Time</th>
            <th className={pad}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.player_id}
              className={`border-b border-slate-100 ${r.is_winner ? "bg-amber-50 font-semibold" : ""} ${!r.eligible ? "text-slate-500" : ""}`}
            >
              <td className={`${pad} tabular-nums`}>{r.rank ?? "-"}</td>
              <td className={pad}>{r.full_name}</td>
              {showEmail ? <td className={`${pad} break-all`}>{r.email}</td> : null}
              <td className={`${pad} tabular-nums`}>{r.correct}/24</td>
              <td className={`${pad} tabular-nums`}>
                {formatDuration(r.elapsed_seconds)}
                {r.submitted_at ? "" : " *"}
              </td>
              <td className={pad}>
                {r.is_winner ? (
                  <span className="rounded-full bg-amber-400 px-2 py-0.5 text-xs font-bold text-amber-950">
                    {r.prize_rank ? `${ordinal(r.prize_rank)} prize` : "Winner"}
                  </span>
                ) : !r.eligible ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                    not eligible
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-slate-500">* did not submit: counted as the full duration.</p>
    </div>
  );
}
