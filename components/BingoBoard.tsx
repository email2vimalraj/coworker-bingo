import type { BoardCell } from "@/lib/supabase/types";
import { BingoCell } from "@/components/BingoCell";

export function BingoBoard({
  board,
  selected,
  onSelect,
  highlight,
}: {
  board: BoardCell[];
  selected: number | null;
  onSelect: (cell: BoardCell) => void;
  /** lines mode: cell indexes that belong to a completed line */
  highlight?: Set<number>;
}) {
  return (
    <div className="grid grid-cols-5 gap-1" role="grid" aria-label="Bingo board">
      {board.map((cell) => (
        <BingoCell
          key={cell.cell_index}
          cell={cell}
          selected={selected === cell.cell_index}
          inLine={highlight?.has(cell.cell_index) ?? false}
          onClick={() => onSelect(cell)}
        />
      ))}
    </div>
  );
}
