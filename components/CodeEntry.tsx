"use client";
import { useState } from "react";
import { normalizePlayerCode } from "@/lib/codes";
import { Button, inputClass } from "@/components/ui";

/** Manual coworker code input. Passes the raw text on (the server also parses URLs). */
export function CodeEntry({
  onSubmit,
  busy,
  label = "Or enter your coworker's code",
}: {
  onSubmit: (raw: string) => void;
  busy?: boolean;
  label?: string;
}) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!normalizePlayerCode(value)) {
      setErr("Codes look like ABC-DEF (6 letters and numbers).");
      return;
    }
    setErr(null);
    onSubmit(value);
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <label className="block text-sm font-semibold text-slate-800" htmlFor="coworker-code">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id="coworker-code"
          className={`${inputClass} font-mono uppercase tracking-widest`}
          placeholder="ABC-DEF"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
        />
        <Button type="submit" disabled={busy || !value.trim()}>
          {busy ? "..." : "Go"}
        </Button>
      </div>
      {err ? <p className="text-sm font-medium text-red-600">{err}</p> : null}
    </form>
  );
}
