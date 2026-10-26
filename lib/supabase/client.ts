import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MISSING_ENV_MESSAGE, SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase/env";

let client: SupabaseClient | null = null;

/** Browser Supabase client (singleton). Call from effects/handlers, not during render on the server. */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = SUPABASE_URL;
  const key = SUPABASE_KEY;
  if (!url || !key) throw new Error(MISSING_ENV_MESSAGE);
  client = createBrowserClient(url, key);
  return client;
}
