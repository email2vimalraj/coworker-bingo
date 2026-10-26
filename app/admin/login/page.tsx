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
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    if (mode === "signup") {
      const { data, error: upErr } = await getSupabase().auth.signUp({ email: email.trim(), password });
      setBusy(false);
      if (upErr) {
        setError(upErr.message || "Couldn't create the account.");
        return;
      }
      if (data.session) {
        router.replace("/admin");
        router.refresh();
        return;
      }
      setNotice("Check your email to confirm, then sign in.");
      setMode("signin");
      return;
    }
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
        <h1 className="text-3xl font-extrabold">{mode === "signup" ? "Create admin account" : "Admin sign in"}</h1>
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
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            minLength={mode === "signup" ? 6 : undefined}
            required
          />
        </Field>
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {notice ? (
          <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800">
            {notice}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Please wait..." : mode === "signup" ? "Create account" : "Sign in"}
        </Button>
        <button
          type="button"
          className="min-h-11 w-full text-sm font-semibold text-accent"
          onClick={() => {
            setMode(mode === "signup" ? "signin" : "signup");
            setError(null);
            setNotice(null);
          }}
        >
          {mode === "signup" ? "Have an account? Sign in" : "Need an account? Create one"}
        </button>
      </form>
    </main>
  );
}
