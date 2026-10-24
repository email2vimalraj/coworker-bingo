"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { normalizeSessionCode } from "@/lib/codes";
import { Button, inputClass } from "@/components/ui";

export default function Home() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function go(e: React.FormEvent) {
    e.preventDefault();
    const code = normalizeSessionCode(value);
    if (!code) {
      setError("Session codes are 6 letters and numbers, like K7PQ2X.");
      return;
    }
    router.push(`/join/${code}`);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 p-4">
      <header className="text-center">
        <h1 className="text-4xl font-extrabold tracking-tight">Coworker Bingo</h1>
        <p className="mt-2 text-lg text-slate-600">Meet your coworkers. Fill your card. Win prizes.</p>
      </header>
      <form onSubmit={go} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <label htmlFor="session-code" className="block text-sm font-semibold">
          Enter your session code
        </label>
        <input
          id="session-code"
          className={`${inputClass} text-center font-mono text-2xl uppercase tracking-[0.3em]`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="K7PQ2X"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
        <Button type="submit" className="w-full">
          Join a game
        </Button>
        <p className="text-center text-sm text-slate-500">Or scan the QR code on the big screen.</p>
      </form>
      <p className="text-center text-sm">
        <Link href="/admin" className="font-semibold text-accent">
          Host? Admin sign in
        </Link>
      </p>
    </main>
  );
}
