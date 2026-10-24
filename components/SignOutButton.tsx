"use client";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { Button } from "@/components/ui";

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        await getSupabase().auth.signOut();
        router.replace("/admin/login");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
