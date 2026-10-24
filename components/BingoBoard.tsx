import type { BoardCell } from "@/lib/supabase/types";
import { BingoCell } from "@/components/BingoCell";

export function BingoBoard({
  board,
  selected,
  onSelect,
}: {
  board: BoardCell[];
  selected: number | null;
  onSelect: (cell: BoardCell) => void;
}) {
  return (
    <div className="grid grid-cols-5 gap-1" role="grid" aria-label="Bingo board">
      {board.map((cell) => (
        <BingoCell
          key={cell.cell_index}
          cell={cell}
          selected={selected === cell.cell_index}
          onClick={() => onSelect(cell)}
        />
      ))}
    </div>
  );
}
