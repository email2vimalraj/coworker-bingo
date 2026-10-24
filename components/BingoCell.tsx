import type { BoardCell } from "@/lib/supabase/types";

export function BingoCell({
  cell,
  selected,
  onClick,
}: {
  cell: BoardCell;
  selected?: boolean;
  onClick: () => void;
}) {
  if (cell.is_free) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-lg bg-indigo-100 text-xs font-extrabold tracking-wide text-accent">
        FREE
      </div>
    );
  }
  let tone = "bg-white border-slate-300 text-slate-900";
  let sub: string | null = null;
  if (cell.status === "confirmed") {
    tone = "bg-emerald-100 border-emerald-500 text-emerald-950";
    sub = cell.coworker_name;
  } else if (cell.status === "pending") {
    tone = "bg-amber-100 border-amber-500 text-amber-950";
    sub = cell.coworker_name ? `Waiting for ${cell.coworker_name}` : "Waiting...";
  } else if (cell.last_outcome) {
    tone = "bg-white border-red-400 text-slate-900";
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${cell.prompt ?? ""}${sub ? `, ${sub}` : ""}`}
      className={`flex aspect-square min-h-11 min-w-0 flex-col items-stretch justify-between overflow-hidden rounded-lg border-2 p-1 text-left leading-tight transition-transform active:scale-95 ${tone} ${selected ? "ring-2 ring-accent" : ""}`}
    >
      <span className="line-clamp-4 break-words text-[11px] font-semibold sm:text-xs">
        {cell.prompt}
      </span>
      {sub ? (
        <span className="line-clamp-2 break-words text-[10px] font-bold sm:text-[11px]">{sub}</span>
      ) : cell.last_outcome ? (
        <span className="text-[9px] font-bold text-red-600 sm:text-[11px]">Try again</span>
      ) : null}
    </button>
  );
}
