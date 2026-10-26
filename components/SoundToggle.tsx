"use client";
import { useAlertsEnabled } from "@/lib/useAlerts";

/** Bell button toggling sound + vibration alerts. */
export function SoundToggle({ className = "" }: { className?: string }) {
  const [on, setOn] = useAlertsEnabled();
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? "Sound and vibration on" : "Sound and vibration off"}
      onClick={() => setOn(!on)}
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-slate-300 ${on ? "bg-white text-slate-900" : "bg-slate-100 text-slate-400"} ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
        {on ? null : <path d="M3 3l18 18" />}
      </svg>
    </button>
  );
}
