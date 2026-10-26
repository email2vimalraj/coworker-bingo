"use client";
import { useState } from "react";
import { Button, inputClass } from "@/components/ui";

/** Manual coworker code / username / email input. Passes the raw text on (the server also parses URLs). */
export function CodeEntry({
  onSubmit,
  busy,
  label,
  allowUsername = true,
}: {
  onSubmit: (raw: string) => void;
  busy?: boolean;
  label?: string;
  /** When the session disallows usernames/emails, only a code is accepted. */
  allowUsername?: boolean;
}) {
  const text = label ?? (allowUsername ? "Or enter your coworker's code or username" : "Or enter your coworker's code");
  const [value, setValue] = useState("");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    onSubmit(value.trim());
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <label className="block text-sm font-semibold text-slate-800" htmlFor="coworker-code">
        {text}
      </label>
      <div className="flex gap-2">
        <input
          id="coworker-code"
          className={inputClass}
          placeholder={allowUsername ? "QX7-4PM or player1" : "QX7-4PM"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoCapitalize="none"
          inputMode="email"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
        />
        <Button type="submit" disabled={busy || !value.trim()}>
          {busy ? "..." : "Go"}
        </Button>
      </div>
    </form>
  );
}
