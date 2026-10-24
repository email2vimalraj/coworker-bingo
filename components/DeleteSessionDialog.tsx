"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { Button, ErrorBox, inputClass } from "@/components/ui";

/** In-page "type the session name to confirm" delete step. */
export function DeleteSessionDialog({
  sessionId,
  sessionName,
  onCancel,
  onDeleted,
}: {
  sessionId: string;
  sessionName: string;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === sessionName.trim();

  async function del() {
    setBusy(true);
    setError(null);
    try {
      const { error: err, count } = await getSupabase()
        .from("sessions")
        .delete({ count: "exact" })
        .eq("id", sessionId);
      if (err) throw err;
      if (!count) throw new Error("Nothing was deleted.");
      onDeleted();
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-2xl border-2 border-red-300 bg-red-50 p-4">
      <p className="font-semibold text-red-900">
        Delete &ldquo;{sessionName}&rdquo; and all its players and claims? This can&apos;t be undone.
      </p>
      <label className="block text-sm font-medium text-red-900">
        Type the session name to confirm
        <input
          className={`${inputClass} mt-1`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={sessionName}
          autoComplete="off"
        />
      </label>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={del} disabled={!matches || busy}>
          {busy ? "Deleting..." : "Delete forever"}
        </Button>
      </div>
    </div>
  );
}
