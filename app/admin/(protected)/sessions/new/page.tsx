"use client";
import { useRouter } from "next/navigation";
import { rpc } from "@/lib/api";
import { SessionForm, type SessionPayload } from "@/components/SessionForm";

export default function NewSession() {
  const router = useRouter();
  async function create(payload: SessionPayload) {
    const res = await rpc<{ id: string; code: string }>("create_session", { ...payload });
    router.push(`/admin/sessions/${res.id}`);
  }
  return (
    <SessionForm
      title="Create session"
      submitLabel="Create session"
      busyLabel="Creating..."
      backHref="/admin"
      backLabel="All sessions"
      onSubmit={create}
    />
  );
}
