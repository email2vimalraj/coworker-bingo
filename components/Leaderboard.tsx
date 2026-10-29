import { ordinal } from "@/lib/format";
import { formatDuration } from "@/lib/useCountdown";
import type { RankingMode } from "@/lib/ranking";
import type { LeaderboardRow } from "@/lib/supabase/types";

export function Leaderboard({
  rows,
  showEmail = true,
  big = false,
  onManage,
  onAward,
  mode = "correct_then_time",
}: {
  rows: LeaderboardRow[];
  showEmail?: boolean;
  big?: boolean;
  /** When set, each row gets a "Manage" button. */
  onManage?: (row: LeaderboardRow) => void;
  /** When set, non-winner rows get a "Give prize" button (only pass it while prize places are empty). */
  onAward?: (row: LeaderboardRow) => void;
  mode?: RankingMode;
}) {
  const showLines = mode === "lines";
  if (rows.length === 0) {
    return <p className="p-4 text-slate-500">No players yet.</p>;
  }
  const text = big ? "text-2xl" : "text-sm";
  const pad = big ? "px-4 py-3" : "px-3 py-2";
  return (
    <div className="overflow-x-auto">
      <table className={`w-full min-w-[40rem] border-collapse text-left ${text}`}>
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <th className={pad}>Rank</th>
            <th className={pad}>Name</th>
            {showEmail ? <th className={pad}>Email</th> : null}
            {showLines ? <th className={pad}>Lines</th> : null}
            <th className={pad}>Correct</th>
            <th className={pad}>Time</th>
            <th className={pad}>Status</th>
            {onManage ? <th className={pad}></th> : null}
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
              {showLines ? <td className={`${pad} tabular-nums`}>{r.lines}</td> : null}
              <td className={`${pad} tabular-nums`}>{r.correct}/24</td>
              <td className={`${pad} tabular-nums`}>
                {showLines && r.reach_seconds !== null ? (
                  formatDuration(r.reach_seconds)
                ) : (
                  <>
                    {formatDuration(r.elapsed_seconds)}
                    {r.submitted_at ? "" : " *"}
                  </>
                )}
              </td>
              <td className={pad}>
                {r.host_pick ? (
                  <span className="rounded-full bg-amber-400 px-2 py-0.5 text-xs font-bold text-amber-950">
                    Host&apos;s pick &middot; {ordinal(r.prize_place ?? r.award_place ?? 0)}
                  </span>
                ) : r.is_winner ? (
                  <span className="rounded-full bg-amber-400 px-2 py-0.5 text-xs font-bold text-amber-950">
                    {r.prize_rank ? `${ordinal(r.prize_rank)} prize` : "Winner"}
                  </span>
                ) : !r.eligible ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                    not eligible
                  </span>
                ) : null}
              </td>
              {onManage ? (
                <td className={`${pad} whitespace-nowrap`}>
                  {onAward && !r.is_winner ? (
                    <button
                      type="button"
                      onClick={() => onAward(r)}
                      className="mr-2 min-h-11 rounded-xl border border-amber-400 bg-amber-50 px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
                    >
                      Give prize
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onManage(r)}
                    className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
                  >
                    Manage
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-slate-500">
        * did not submit: counted as the full duration.
        {showLines ? " For players who reached the line target, Time is when their last needed line completed." : ""}
      </p>
    </div>
  );
}
