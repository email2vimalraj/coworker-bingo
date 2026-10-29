import type { LeaderboardRow } from "@/lib/supabase/types";
import { formatDuration } from "@/lib/useCountdown";
import { ordinal } from "@/lib/format";

/** Winners in prize order (1st first). */
export function sortWinners(rows: LeaderboardRow[]): LeaderboardRow[] {
  return rows
    .filter((r) => r.is_winner)
    .sort((a, b) => (a.prize_rank ?? 999) - (b.prize_rank ?? 999) || (a.rank ?? 999) - (b.rank ?? 999));
}

/** The order the host reveals in: lowest prize first, 1st place last. */
export function revealOrder(winners: LeaderboardRow[]): LeaderboardRow[] {
  return [...winners].reverse();
}

const SLOTS = [
  { place: 0, height: "h-[34vmin]", color: "bg-amber-400 text-amber-950", order: "order-2" },
  { place: 1, height: "h-[26vmin]", color: "bg-slate-300 text-slate-900", order: "order-1" },
  { place: 2, height: "h-[20vmin]", color: "bg-orange-400 text-orange-950", order: "order-3" },
];

function Details({ row }: { row: LeaderboardRow }) {
  return (
    <p className="text-[clamp(1rem,2.6vmin,2.5rem)] font-semibold tabular-nums">
      {row.correct}/24 &middot; {formatDuration(row.elapsed_seconds)}
    </p>
  );
}

/**
 * Podium for up to 3 winners (1st centre and tallest, 2nd left, 3rd right), with winners 4+ listed below.
 * `revealed` is how many winners are visible, counted from the lowest prize upwards.
 */
export function Podium({ winners, revealed }: { winners: LeaderboardRow[]; revealed: number }) {
  const total = winners.length;
  const isShown = (idx: number) => total - idx <= revealed;
  const rest = winners.slice(3);
  return (
    <div className="flex w-full flex-col items-center gap-[3vmin]">
      <div className="flex w-full max-w-[90vw] items-end justify-center gap-[2vmin]">
        {SLOTS.map((slot) => {
          const row = winners[slot.place];
          if (!row) return null;
          const shown = isShown(slot.place);
          return (
            <div key={slot.place} className={`flex min-w-0 flex-1 flex-col items-center text-center ${slot.order}`}>
              <div
                className={`mb-[1vmin] w-full min-w-0 transition-all duration-700 motion-reduce:transition-none ${shown ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"}`}
                aria-hidden={!shown}
              >
                <p className="break-words text-[clamp(1.5rem,5.5vmin,5rem)] font-extrabold leading-tight">{row.full_name}</p>
                <Details row={row} />
              </div>
              <div
                className={`flex w-full items-start justify-center rounded-t-2xl pt-[1.5vmin] ${slot.height} ${shown ? slot.color : "bg-slate-800 text-slate-500"}`}
              >
                <span className="text-[clamp(2rem,8vmin,7rem)] font-black">
                  {shown ? ordinal(row.prize_rank ?? slot.place + 1) : "?"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {rest.length > 0 ? (
        <ol className="w-full max-w-[80vw] space-y-[0.6vmin]">
          {rest.map((row, i) => {
            const shown = isShown(i + 3);
            return (
              <li
                key={row.player_id}
                className={`flex items-center gap-[2vmin] rounded-xl bg-slate-800 px-[2vmin] py-[0.8vmin] text-[clamp(1.1rem,3.2vmin,2.75rem)] transition-opacity duration-700 motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
              >
                <span className="w-[3em] shrink-0 font-bold tabular-nums text-amber-300">
                  {ordinal(row.prize_rank ?? i + 4)}
                </span>
                <span className="min-w-0 flex-1 truncate font-semibold">{row.full_name}</span>
                <span className="shrink-0 tabular-nums">{row.correct}/24</span>
                <span className="w-[3.6em] shrink-0 text-right font-mono tabular-nums text-slate-400">
                  {formatDuration(row.elapsed_seconds)}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
