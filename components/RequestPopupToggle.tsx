"use client";
import { useRequestPopups } from "@/lib/requestPrefs";

export function RequestPopupToggle() {
  const [on, setOn] = useRequestPopups();
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3">
      <input type="checkbox" className="h-5 w-5 accent-indigo-600" checked={on} onChange={(e) => setOn(e.target.checked)} />
      <span className="text-base font-semibold">Show requests as pop-ups</span>
    </label>
  );
}
