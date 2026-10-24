/**
 * Load test: simulates N players against a STAGING Supabase project.
 *
 *   npx tsx scripts/load-test.ts --url https://xxx.supabase.co --anon-key eyJ... \
 *     --session ABC123 --players 450 --minutes 5
 *
 * Flow: join N fake players (loadtest+i@example.com), poll player_poll every ~3s with jitter,
 * periodically create a claim on a random open cell against a random other player, the target
 * answers on its next poll (accepts ~80%), and everyone submits near the end.
 * The session must be started (status live) by an admin; the test waits for that.
 * Clean up by deleting the session in the admin UI (cascades to players, boards, claims).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ERROR_CODES } from "../lib/errors";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : def;
  if (v === undefined) {
    console.error(`Missing --${name}`);
    process.exit(2);
  }
  return v;
}
const URL_ = arg("url", process.env.NEXT_PUBLIC_SUPABASE_URL);
const KEY = arg("anon-key", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const CODE = arg("session").toUpperCase();
const N = Number(arg("players", "450"));
const MINUTES = Number(arg("minutes", "5"));
const POLL_MS = Number(arg("poll-ms", "3000"));
const CLAIM_EVERY_MS = Number(arg("claim-every-s", "20")) * 1000;
const ACCEPT_RATE = 0.8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

const latencies = new Map<string, number[]>();
const counts = new Map<string, { ok: number; err: number }>();
const errorCodes = new Map<string, number>();

async function call<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T | null> {
  const t0 = performance.now();
  let res;
  try {
    res = await sb.rpc(fn, args);
  } catch (e) {
    record(fn, performance.now() - t0, `NETWORK:${(e as Error).message.slice(0, 40)}`);
    return null;
  }
  const dt = performance.now() - t0;
  if (res.error) {
    const msg = res.error.message || "";
    const code = ERROR_CODES.find((c) => msg.includes(c)) ?? `HTTP/${res.status}:${res.error.code ?? msg.slice(0, 40)}`;
    record(fn, dt, code);
    return null;
  }
  record(fn, dt, null);
  return res.data as T;
}
function record(fn: string, ms: number, err: string | null) {
  if (!latencies.has(fn)) latencies.set(fn, []);
  latencies.get(fn)!.push(ms);
  const c = counts.get(fn) ?? { ok: 0, err: 0 };
  if (err) {
    c.err++;
    errorCodes.set(err, (errorCodes.get(err) ?? 0) + 1);
  } else c.ok++;
  counts.set(fn, c);
}
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

interface Poll {
  session: { status: string; ends_at: string | null };
  server_now: string;
  board: { cell_index: number; is_free: boolean; status: string | null }[];
  incoming: { claim_id: string }[];
  me: { submitted_at: string | null };
}
interface Bot {
  i: number;
  sb: SupabaseClient;
  token: string;
  code: string;
}

const bots: Bot[] = [];
let stop = false;
let live = false;

async function runBot(bot: Bot, deadline: number) {
  let lastClaim = Date.now() + rand(0, CLAIM_EVERY_MS);
  let submitted = false;
  await sleep(rand(0, POLL_MS));
  while (!stop && Date.now() < deadline) {
    const p = await call<Poll>(bot.sb, "player_poll", { p_token: bot.token });
    if (p) {
      const status = p.session.status;
      if (status === "live") live = true;
      if (status === "ended") break;
      for (const inc of p.incoming) {
        await call(bot.sb, "respond_claim", { p_token: bot.token, p_claim_id: inc.claim_id, p_accept: Math.random() < ACCEPT_RATE });
      }
      if (status === "live" && !p.me.submitted_at && !submitted) {
        const left = p.session.ends_at ? new Date(p.session.ends_at).getTime() - new Date(p.server_now).getTime() : Infinity;
        if (left < 20_000 || Date.now() > deadline - 20_000) {
          submitted = (await call(bot.sb, "submit_board", { p_token: bot.token })) !== null;
        } else if (Date.now() - lastClaim > CLAIM_EVERY_MS && bots.length > 1) {
          lastClaim = Date.now();
          const open = p.board.filter((c) => !c.is_free && !c.status);
          const other = bots[Math.floor(Math.random() * bots.length)];
          if (open.length > 0 && other !== bot) {
            const cell = open[Math.floor(Math.random() * open.length)];
            await call(bot.sb, "create_claim", { p_token: bot.token, p_cell_index: cell.cell_index, p_coworker_code: other.code });
          }
        }
      }
    }
    await sleep(POLL_MS * rand(0.8, 1.3));
  }
}

async function main() {
  console.log(`Load test: ${N} players, ${MINUTES} min, session ${CODE}, ${URL_}`);
  const t0 = Date.now();
  // Join in waves of 25 so the ramp-up resembles people scanning the QR over ~30s.
  const mk = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  for (let start = 0; start < N; start += 25) {
    await Promise.all(
      Array.from({ length: Math.min(25, N - start) }, async (_, k) => {
        const i = start + k;
        const sb = mk();
        const r = await call<{ player_token: string; player_code: string }>(sb, "join_session", {
          p_code: CODE,
          p_full_name: `Load Test ${i}`,
          p_email: `loadtest+${i}@example.com`,
        });
        if (r) bots.push({ i, sb, token: r.player_token, code: r.player_code });
      }),
    );
    await sleep(rand(200, 800));
  }
  console.log(`Joined ${bots.length}/${N} in ${((Date.now() - t0) / 1000).toFixed(1)}s. Waiting for the session to go live (start it in the admin UI)...`);
  const deadline = Date.now() + MINUTES * 60_000;
  const runners = bots.map((b) => runBot(b, deadline));
  process.on("SIGINT", () => {
    stop = true;
  });
  await Promise.all(runners);
  report(live);
}

function report(wasLive: boolean) {
  console.log("\n=== Results ===");
  if (!wasLive) console.log("WARNING: the session never went live during the test; claims were not exercised.");
  console.log("\nRPC               ok     err    p50ms   p95ms   p99ms   max");
  for (const [fn, arr] of [...latencies.entries()].sort()) {
    const s = [...arr].sort((a, b) => a - b);
    const c = counts.get(fn)!;
    console.log(
      `${fn.padEnd(16)} ${String(c.ok).padStart(6)} ${String(c.err).padStart(6)} ${pct(s, 50).toFixed(0).padStart(8)} ${pct(s, 95).toFixed(0).padStart(7)} ${pct(s, 99).toFixed(0).padStart(7)} ${s[s.length - 1].toFixed(0).padStart(6)}`,
    );
  }
  console.log("\nError codes:");
  if (errorCodes.size === 0) console.log("  (none)");
  for (const [c, n] of [...errorCodes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(30)} ${n}`);
  console.log(
    "\nNote: business errors such as COWORKER_LIMIT, CELL_TAKEN, CLAIM_NOT_PENDING are expected under random play;" +
      "\nlook for NETWORK:*, HTTP/* (429, 5xx, timeouts) and p95 > 500ms for polls.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
