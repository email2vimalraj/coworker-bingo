import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { MISSING_ENV_MESSAGE, SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase/env";

/** Server Supabase client bound to the request cookies (admin pages). */
export async function createClient() {
  const cookieStore = await cookies();
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error(MISSING_ENV_MESSAGE);
  return createServerClient(
    SUPABASE_URL,
    SUPABASE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component: middleware refreshes the session instead.
          }
        },
      },
    },
  );
}
