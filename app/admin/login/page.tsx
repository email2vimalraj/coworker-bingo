"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { Button, ErrorBox, Field, inputClass } from "@/components/ui";

export default function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await getSupabase().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (err) {
      setError(err.message || "Couldn't sign in.");
      setBusy(false);
      return;
    }
    router.replace("/admin");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 p-4">
      <header className="text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-accent">Coworker Bingo</p>
        <h1 className="text-3xl font-extrabold">Admin sign in</h1>
      </header>
      <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <Field label="Email">
          <input
            className={inputClass}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </Field>
        <Field label="Password">
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
