"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "@/components/PlayerProvider";
import { RequestPopupToggle } from "@/components/RequestPopupToggle";
import { Button } from "@/components/ui";
import { buildRules } from "@/lib/rules";

/** "?" button in the player header; opens a sheet with rules generated from the session's settings. */
export function HelpButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="How to play"
        onClick={() => setOpen(true)}
        className={`inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-900 ${className}`}
      >
        <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4" />
          <path d="M12 17.5h.01" />
        </svg>
      </button>
      {open ? <HelpSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function HelpSheet({ onClose }: { onClose: () => void }) {
  const { data } = usePlayer();
  const s = data.session;
  const sections = buildRules({
    duration_seconds: s.duration_seconds,
    max_squares_per_coworker: s.max_squares_per_coworker,
    winners_count: s.winners_count,
    ranking_mode: s.ranking_mode,
    lines_to_win: s.lines_to_win,
    require_full_card: !!s.require_full_card,
    allow_username_claims: s.allow_username_claims !== false,
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Stop the board behind the sheet from scrolling.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Portal to <body>: the sticky header uses backdrop-blur, which would otherwise
  // trap this fixed overlay inside the header's box.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end bg-slate-900/60" onClick={onClose} role="dialog" aria-modal="true" aria-label="How to play">
      <div
        className="animate-sheet-up mx-auto max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(2rem,env(safe-area-inset-bottom))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-2xl font-extrabold">How to play</h2>
        <div className="space-y-4">
          {sections.map((sec) => (
            <section key={sec.heading}>
              <h3 className="mb-1 text-base font-bold text-accent">{sec.heading}</h3>
              <ul className="list-disc space-y-1 pl-5 text-base text-slate-700">
                {sec.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
            </section>
          ))}
          <RequestPopupToggle />
        </div>
        <Button variant="ghost" className="mt-3 w-full" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>,
    document.body,
  );
}
