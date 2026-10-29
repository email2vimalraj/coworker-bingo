/**
 * Fully automated end-to-end load test with live monitoring and a report.
 *
 *   LOADTEST_ADMIN_EMAIL=... LOADTEST_ADMIN_PASSWORD=... \
 *   npx tsx scripts/load-e2e.ts --url https://xxx.supabase.co --key sb_publishable_... \
 *     --players 470 --minutes 5
 *
 * It signs in as an admin, creates a session, joins N bots, starts the game, simulates play
 * (polling like lib/pollInterval.ts, claims by code/username, late answers, submits near the end),
 * optionally pauses/resumes, ends the game, keeps polling the results, then deletes the session
 * and writes load-reports/<runid>/{summary.json,timeseries.csv,report.html}.
 * Exit code 0 = PASS, 1 = FAIL. See README ("Load test") for details.
 *
 * NEVER run it during a real game: the traffic competes with real players.
 */
import { createInterface } from "node:readline/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join as pjoin } from "node:path";
import { loadavg, cpus } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PROMPTS } from "../lib/defaultPrompts";
import { ERROR_CODES } from "../lib/errors";
import { intervalFor } from "../lib/pollInterval";
import type { PollResponse } from "../lib/supabase/types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}
function num(name: string, def: number): number {
  const v = opt(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) die(`--${name} must be a number`);
  return n;
}
function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const URL_ = opt("url") ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? die("Missing --url (or NEXT_PUBLIC_SUPABASE_URL)");
const KEY =
  opt("key") ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  die("Missing --key (publishable key) or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const ADMIN_EMAIL = process.env.LOADTEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.LOADTEST_ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) die("Set LOADTEST_ADMIN_EMAIL and LOADTEST_ADMIN_PASSWORD in the environment (never as flags).");

function looksLikeSecretKey(k: string): boolean {
  if (k.startsWith("sb_secret_")) return true;
  const parts = k.split(".");
  if (parts.length === 3) {
    try {
      return JSON.parse(Buffer.from(parts[1], "base64url").toString()).role === "service_role";
    } catch {
      return false;
    }
  }
  return false;
}
if (looksLikeSecretKey(KEY)) die("Refusing to run: that is a secret/service-role key. Use the publishable (anon) key.");

const CFG = {
  players: num("players", 470),
  minutes: num("minutes", 5),
  joinRampS: num("join-ramp-s", 60),
  prompts: num("prompts", 24),
  pauseAtS: opt("pause-at-s") === undefined ? null : num("pause-at-s", 0),
  pauseS: num("pause-s", 30),
  afterEndS: num("after-end-s", 60),
  qrOpenPct: num("qr-open-pct", 15),
  claimEveryS: num("claim-every-s", 20),
  keep: flag("keep"),
  reportDir: opt("report-dir") ?? "load-reports",
};
const TH = {
  maxFailPct: num("max-fail-pct", 0.1), // failures / all calls, in percent
  p95Ms: num("p95-ms", 500),
  rtMinPct: num("rt-min-pct", 99),
  rtP95Ms: num("rt-p95-ms", 5000),
};
if (CFG.players < 2) die("--players must be at least 2");
if (CFG.prompts < 24 || CFG.prompts > 200) die("--prompts must be between 24 and 200");
const durationSeconds = Math.round((CFG.minutes + (CFG.pauseAtS === null ? 0 : CFG.pauseS / 60)) * 60 + 600);
if (durationSeconds > 28800) die("--minutes too large (session duration is capped at 8 hours)");

const HOST = new URL(URL_).host;
const IS_LOCAL = /^(127\.0\.0\.1|localhost)(:|$)/.test(HOST);
const RUN_ID = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}-${Math.random().toString(36).slice(2, 6)}`;
const REPORT_PATH = pjoin(CFG.reportDir, RUN_ID);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
const nowMs = () => Date.now();

let aborted = false;
let botsStop = false;
let resolveAbort: () => void = () => {};
const abortP = new Promise<void>((r) => (resolveAbort = r));
let resolveStop: () => void = () => {};
const stopP = new Promise<void>((r) => (resolveStop = r));
/** Sleep that ends early on Ctrl+C. */
const sleep = (ms: number) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  void abortP.then(() => { clearTimeout(t); r(); });
});
/** Sleep for bots: ends early when bots are told to stop (or on Ctrl+C). */
const botSleep = (ms: number) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  void stopP.then(() => { clearTimeout(t); r(); });
});

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
/** Business outcomes that are normal under random play. Everything else with an error is a failure. */
const EXPECTED = new Set([
  "COWORKER_LIMIT", "CELL_TAKEN", "PAUSED", "TIME_UP", "CLAIM_NOT_PENDING", "CLAIM_NOT_FOUND", "ALREADY_SUBMITTED",
  "SESSION_ENDED", "NOT_LIVE", "SELF_SCAN", "COWORKER_NOT_FOUND", "USERNAME_AMBIGUOUS",
]);
const ADMIN_LABELS = new Set(["create_session", "start_session", "pause_session", "resume_session", "end_session", "admin_reveal_results", "server_now"]);
const MAIN_LABELS = [
  "join_session", "player_poll[lobby]", "player_poll[live]", "player_poll[paused]", "player_poll[ended]", "player_poll[revealed]",
  "create_claim", "respond_claim", "submit_board",
];
// player_poll[ended] = after the end, before "Reveal winners" (cheap: no leaderboard);
// player_poll[revealed] = after the reveal, when every phone fetches the results (the post-end herd).
const P95_CHECKED = ["join_session", "player_poll[live]", "create_claim", "respond_claim", "player_poll[ended]", "player_poll[revealed]"];

class Stat {
  lat: number[] = [];
  ok = 0;
  expected = 0;
  failure = 0;
  codes = new Map<string, number>();
  add(ms: number, code: string | null, kind: "ok" | "expected" | "failure") {
    this.lat.push(ms);
    this[kind]++;
    if (code) this.codes.set(code, (this.codes.get(code) ?? 0) + 1);
  }
  get n() {
    return this.ok + this.expected + this.failure;
  }
  summary() {
    const s = sorted(this.lat);
    return {
      count: this.n, ok: this.ok, expected_errors: this.expected, failures: this.failure,
      p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.length ? s[s.length - 1] : null,
      error_codes: Object.fromEntries(this.codes),
    };
  }
}
interface Win {
  start: number;
  lat: Map<string, number[]>;
  playerCalls: number;
  failures: number;
  expected: number;
  active: Set<number>;
  rtEvents: number;
  rtLags: number[];
}
const newWin = (): Win => ({ start: nowMs(), lat: new Map(), playerCalls: 0, failures: 0, expected: 0, active: new Set(), rtEvents: 0, rtLags: [] });

type Phase = "setup" | "join" | "lobby" | "live" | "paused" | "ended" | "cleanup";
let phase: Phase = "setup";
let T0 = nowMs();
const elapsedS = () => (nowMs() - T0) / 1000;
const markers: { t: number; label: string }[] = [];
function setPhase(p: Phase, marker?: string) {
  phase = p;
  if (marker) markers.push({ t: elapsedS(), label: marker });
}

const cumStats = new Map<string, Stat>();
const phaseStats = new Map<string, Stat>(); // key: phase|label
let win = newWin();
let totalCalls = 0;
let totalFailures = 0;
let totalExpected = 0;
const failureSamples = new Map<string, number>();

function record(label: string, ms: number, code: string | null, botId?: number) {
  const kind: "ok" | "expected" | "failure" = code === null ? "ok" : EXPECTED.has(code) ? "expected" : "failure";
  for (const [m, key] of [[cumStats, label], [phaseStats, `${phase}|${label}`]] as const) {
    if (!m.has(key)) m.set(key, new Stat());
    m.get(key)!.add(ms, code, kind);
  }
  totalCalls++;
  if (kind === "failure") {
    totalFailures++;
    failureSamples.set(code!, (failureSamples.get(code!) ?? 0) + 1);
  }
  if (kind === "expected") totalExpected++;
  if (!win.lat.has(label)) win.lat.set(label, []);
  win.lat.get(label)!.push(ms);
  if (!ADMIN_LABELS.has(label)) {
    win.playerCalls++;
    if (botId !== undefined && kind !== "failure") win.active.add(botId);
  }
  if (kind === "failure") win.failures++;
  if (kind === "expected") win.expected++;
}

function errorCode(error: { message?: string; code?: string }, status: number): string {
  const msg = error.message || "";
  const known = Object.keys(KNOWN_CODES).find((c) => msg.includes(c));
  if (known) return known;
  if (status === 0 || /fetch failed|timeout|abort|network|ECONN|ETIMEDOUT|socket/i.test(msg)) return `NETWORK:${msg.replace(/\s+/g, " ").slice(0, 40)}`;
  return `HTTP/${status}:${error.code ?? msg.slice(0, 30)}`;
}
const KNOWN_CODES: Record<string, true> = Object.fromEntries(ERROR_CODES.map((c) => [c, true as const]));

async function call<T>(
  sb: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  label: string | ((data: T) => string),
  botId?: number,
  fallbackLabel?: () => string,
): Promise<T | null> {
  const t0 = performance.now();
  let res;
  try {
    res = await sb.rpc(fn, args);
  } catch (e) {
    record(typeof label === "string" ? label : (fallbackLabel?.() ?? fn), performance.now() - t0, `NETWORK:${(e as Error).message.slice(0, 40)}`, botId);
    return null;
  }
  const dt = performance.now() - t0;
  if (res.error) {
    record(typeof label === "string" ? label : (fallbackLabel?.() ?? fn), dt, errorCode(res.error, res.status), botId);
    return null;
  }
  const data = res.data as T;
  record(typeof label === "string" ? label : label(data), dt, null, botId);
  return data;
}

function timeoutFetch(ms: number): typeof fetch {
  return async (input, init) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(input, { ...init, signal: ctl.signal });
    } catch (e) {
      if (ctl.signal.aborted) throw new Error(`timeout after ${ms}ms`);
      throw e;
    } finally {
      clearTimeout(t);
    }
  };
}

// ---------------------------------------------------------------------------
// State shared by the run
// ---------------------------------------------------------------------------
interface Bot {
  i: number;
  token: string;
  code: string;
  username: string;
  state: "lobby" | "live" | "paused" | "ended";
  submitted: boolean;
  qrOpen: boolean;
  nextClaimAt: number;
  submitAtMs: number; // active live ms after which this bot submits
  deferred: Set<string>;
}
const bots: Bot[] = [];
let submittedCount = 0;
let joinResolved = 0;
let liveStartMs = 0;
let pausedTotalMs = 0;
let pausedSince = 0;
const activeElapsedMs = () => (liveStartMs === 0 ? 0 : nowMs() - liveStartMs - pausedTotalMs - (pausedSince ? nowMs() - pausedSince : 0));

let admin: SupabaseClient;
let botSb: SupabaseClient;
let sessionId = "";
let sessionCode = "";
let sessionDeleted: boolean | null = null;
let clockOffsetMs = 0;
let channel: RealtimeChannel | null = null;
let claimsCreated = 0;
let rtInserts = 0;
let rtUpdates = 0;
const rtLagsAll: number[] = [];
let rtSubscribed = false;

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------
async function runBot(i: number, joinAtMs: number) {
  await botSleep(joinAtMs);
  if (botsStop) return;
  let bot: Bot | null = null;
  for (let attempt = 0; attempt < 4 && !bot && !botsStop; attempt++) {
    if (attempt > 0) await botSleep(rand(1000, 3000));
    const r = await call<{ player_token: string; player_code: string }>(
      botSb, "join_session",
      { p_code: sessionCode, p_full_name: `Load Test ${i}`, p_email: `loadtest+${RUN_ID}-${i}@example.com` },
      "join_session", i,
    );
    if (r) {
      bot = {
        i, token: r.player_token, code: r.player_code, username: `loadtest+${RUN_ID}-${i}`.toLowerCase(),
        state: "lobby", submitted: false, qrOpen: Math.random() * 100 < CFG.qrOpenPct,
        nextClaimAt: nowMs() + rand(0, CFG.claimEveryS * 1000),
        submitAtMs: CFG.minutes * 60_000 * rand(0.8, 0.97), deferred: new Set(),
      };
      bots.push(bot);
    }
  }
  joinResolved++;
  if (!bot) return;
  const b = bot;
  await botSleep(rand(0, 3000));
  while (!botsStop) {
    const p = await call<PollResponse>(
      botSb, "player_poll", { p_token: b.token },
      (d) => `player_poll[${d.session.status === "live" && d.session.paused ? "paused" : d.session.status === "ended" && d.session.results_revealed ? "revealed" : d.session.status}]`, b.i,
      () => `player_poll[${b.state}]`,
    );
    let wait = 3000;
    if (p) {
      b.state = p.session.status === "live" && p.session.paused ? "paused" : (p.session.status as Bot["state"]);
      if (p.me.submitted_at) b.submitted = true;
      wait = intervalFor(p, b.qrOpen);
      if (p.incoming.length > 0 && wait > 1000 && b.state !== "ended") wait = 1000;
      if (b.state === "live") await playLive(b, p);
    }
    await botSleep(wait * rand(0.8, 1.3));
  }
}

async function playLive(b: Bot, p: PollResponse) {
  // Answer incoming requests: ~80% accept; ~20% of the answers come late (5-30s), like a busy phone.
  for (const inc of p.incoming) {
    if (b.deferred.has(inc.claim_id)) continue;
    if (Math.random() < 0.2) {
      b.deferred.add(inc.claim_id);
      const respondLater = async (): Promise<void> => {
        await botSleep(rand(5000, 30000));
        while (!botsStop && b.state === "paused") await botSleep(3000);
        if (botsStop) return;
        await call(botSb, "respond_claim", { p_token: b.token, p_claim_id: inc.claim_id, p_accept: Math.random() < 0.8 }, "respond_claim", b.i);
        b.deferred.delete(inc.claim_id);
      };
      void respondLater();
    } else {
      await call(botSb, "respond_claim", { p_token: b.token, p_claim_id: inc.claim_id, p_accept: Math.random() < 0.8 }, "respond_claim", b.i);
    }
  }
  if (b.submitted) return;
  if (activeElapsedMs() >= b.submitAtMs) {
    const r = await call(botSb, "submit_board", { p_token: b.token }, "submit_board", b.i);
    if (r !== null) {
      b.submitted = true;
      submittedCount++;
    }
    return;
  }
  if (nowMs() >= b.nextClaimAt) {
    b.nextClaimAt = nowMs() + CFG.claimEveryS * 1000 * rand(0.7, 1.3);
    const open = p.board.filter((c) => !c.is_free && !c.status);
    const other = pick(bots);
    if (open.length > 0 && other !== b) {
      const cell = pick(open);
      // Mostly by player code (QR scan / typed code), sometimes by username (the email part).
      const who = Math.random() < 0.75 ? other.code : other.username;
      const r = await call(botSb, "create_claim", { p_token: b.token, p_cell_index: cell.cell_index, p_coworker_code: who }, "create_claim", b.i);
      if (r !== null) claimsCreated++;
    }
  }
}

// ---------------------------------------------------------------------------
// DB health sampling, time series, live view
// ---------------------------------------------------------------------------
interface Health {
  conn_active?: number; conn_idle?: number; conn_idle_in_tx?: number; conn_total?: number; waiting_locks?: number;
  longest_active_s?: number; xact_commit?: number; xact_rollback?: number; deadlocks?: number;
  blks_hit?: number; blks_read?: number; temp_bytes?: number; db_size_bytes?: number; max_connections?: number;
  unavailable?: string[];
}
let healthEnabled = true;
let prevHealth: { h: Health; at: number } | null = null;
const healthUnavailable = new Set<string>();
const dbPeak = { conn_total: 0, conn_active: 0, waiting_locks: 0, longest_active_s: 0, deadlocks: 0, temp_bytes: 0, max_connections: null as number | null };
let healthFirst: Health | null = null;
let healthLast: Health | null = null;

interface Row {
  t: number; phase: Phase; dt: number; joined: number; active: number; submitted: number;
  reqS: number; failures: number; expected: number;
  labels: Record<string, { n: number; p50: number | null; p95: number | null }>;
  rtEvents: number; rtLagP95: number | null;
  connActive: number | null; connIdle: number | null; connWaiting: number | null; connTotal: number | null;
  txS: number | null; cachePct: number | null; longestActive: number | null;
  loopP99: number; load1: number;
}
const rows: Row[] = [];
let ticking = false;

// Is this machine keeping up? If the Node event loop stalls, every measured latency includes
// that local delay, so a slow laptop could look like a slow Supabase.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const CPU_COUNT = cpus().length;
let loopP99Peak = 0;
let loopLagWindows = 0;
const LOOP_LAG_MS = 200;

async function sampleHealth(): Promise<Health | null> {
  if (!healthEnabled) return null;
  try {
    const r = await admin.rpc("admin_db_health");
    if (r.error) return null;
    return r.data as Health;
  } catch {
    return null;
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const w = win;
    win = newWin();
    const dt = Math.max(0.001, (nowMs() - w.start) / 1000);
    const h = await sampleHealth();
    const labels: Row["labels"] = {};
    for (const l of MAIN_LABELS) {
      const s = sorted(w.lat.get(l) ?? []);
      labels[l] = { n: s.length, p50: pct(s, 50), p95: pct(s, 95) };
    }
    let txS: number | null = null;
    let cache: number | null = null;
    if (h) {
      healthLast = h;
      healthFirst ??= h;
      for (const u of h.unavailable ?? []) healthUnavailable.add(u);
      dbPeak.conn_total = Math.max(dbPeak.conn_total, h.conn_total ?? 0);
      dbPeak.conn_active = Math.max(dbPeak.conn_active, h.conn_active ?? 0);
      dbPeak.waiting_locks = Math.max(dbPeak.waiting_locks, h.waiting_locks ?? 0);
      dbPeak.longest_active_s = Math.max(dbPeak.longest_active_s, h.longest_active_s ?? 0);
      if (h.max_connections !== undefined) dbPeak.max_connections = h.max_connections;
      if (prevHealth) {
        const secs = Math.max(0.001, (nowMs() - prevHealth.at) / 1000);
        const p = prevHealth.h;
        if (h.xact_commit !== undefined && p.xact_commit !== undefined) {
          txS = (h.xact_commit + (h.xact_rollback ?? 0) - p.xact_commit - (p.xact_rollback ?? 0)) / secs;
        }
        if (h.blks_hit !== undefined && p.blks_hit !== undefined && h.blks_read !== undefined && p.blks_read !== undefined) {
          const dh = h.blks_hit - p.blks_hit;
          const dr = h.blks_read - p.blks_read;
          if (dh + dr > 0) cache = (100 * dh) / (dh + dr);
        }
      }
      prevHealth = { h, at: nowMs() };
    }
    const loopP99 = loopDelay.percentile(99) / 1e6;
    loopDelay.reset();
    if (phase !== "setup") {
      loopP99Peak = Math.max(loopP99Peak, loopP99);
      if (loopP99 > LOOP_LAG_MS) loopLagWindows++;
    }
    const load1 = loadavg()[0];
    const lagS = sorted(w.rtLags);
    const row: Row = {
      loopP99, load1,
      t: elapsedS(), phase, dt, joined: bots.length, active: w.active.size, submitted: submittedCount,
      reqS: w.playerCalls / dt, failures: w.failures, expected: w.expected, labels,
      rtEvents: w.rtEvents, rtLagP95: pct(lagS, 95),
      connActive: h?.conn_active ?? null, connIdle: h?.conn_idle ?? null, connWaiting: h?.waiting_locks ?? null, connTotal: h?.conn_total ?? null,
      txS, cachePct: cache, longestActive: h?.longest_active_s ?? null,
    };
    rows.push(row);
    render(row);
  } finally {
    ticking = false;
  }
}

const TTY = process.stdout.isTTY;
const c = (code: number, s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s: string) => c(31, s);
const green = (s: string) => c(32, s);
const yellow = (s: string) => c(33, s);
const dim = (s: string) => c(2, s);
const bold = (s: string) => c(1, s);
const f0 = (v: number | null | undefined) => (v === null || v === undefined ? "-" : v.toFixed(0));
const f1 = (v: number | null | undefined) => (v === null || v === undefined ? "-" : v.toFixed(1));
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function render(r: Row) {
  const cum = (l: string) => cumStats.get(l);
  const lines: string[] = [];
  const liveInfo = liveStartMs ? ` | play time ${mmss(activeElapsedMs() / 1000)} / ${mmss(CFG.minutes * 60)}` : "";
  lines.push(`${bold("LOAD E2E")}  run ${RUN_ID}  ${HOST}  session ${sessionCode}`);
  lines.push(`Phase ${bold(phase.toUpperCase())}  elapsed ${mmss(r.t)}${liveInfo}`);
  lines.push(`Players: joined ${r.joined}/${CFG.players}  active(5s) ${r.active}  submitted ${r.submitted}`);
  const failTxt = `${r.failures} (total ${totalFailures})`;
  lines.push(`Load: ${f0(r.reqS)} req/s   failures last window: ${r.failures > 0 ? red(failTxt) : green(failTxt)}   expected errors: ${r.expected} (total ${totalExpected})`);
  lines.push(dim("RPC (last window)               n     p50ms   p95ms"));
  for (const l of MAIN_LABELS) {
    const s = r.labels[l];
    if (s.n === 0 && !cum(l)) continue;
    const slow = s.p95 !== null && s.p95 > TH.p95Ms;
    const p95s = f0(s.p95).padStart(7);
    lines.push(`  ${l.padEnd(24)} ${String(s.n).padStart(6)} ${f0(s.p50).padStart(8)} ${slow ? red(p95s) : p95s}`);
  }
  const lagBad = r.rtLagP95 !== null && r.rtLagP95 > TH.rtP95Ms;
  const lagTxt = `${f0(r.rtLagP95)}ms`;
  lines.push(`Realtime: ${rtInserts}/${claimsCreated} claim events   lag p95 (window) ${lagBad ? red(lagTxt) : lagTxt}   subscribed ${rtSubscribed ? "yes" : red("NO")}`);
  if (healthEnabled && r.connTotal !== null) {
    const wait = r.connWaiting ?? 0;
    const cacheTxt = r.cachePct === null ? "-" : `${r.cachePct.toFixed(1)}%`;
    const cacheS = r.cachePct !== null && r.cachePct < 95 ? yellow(cacheTxt) : cacheTxt;
    const waitS = wait > 0 ? red(String(wait)) : String(wait);
    const near = dbPeak.max_connections && r.connTotal > dbPeak.max_connections * 0.8;
    const totS = near ? yellow(String(r.connTotal)) : String(r.connTotal);
    lines.push(`DB: connections active ${r.connActive} idle ${r.connIdle} waiting ${waitS} total ${totS}${dbPeak.max_connections ? `/${dbPeak.max_connections}` : ""}   tx/s ${f0(r.txS)}   cache hit ${cacheS}   longest query ${f1(r.longestActive)}s`);
  } else {
    lines.push(dim("DB: health metrics unavailable"));
  }
  const loopBad = r.loopP99 > LOOP_LAG_MS;
  const loopTxt = `${f0(r.loopP99)}ms`;
  const loadTxt = `${r.load1.toFixed(1)} on ${CPU_COUNT} cores`;
  lines.push(`This machine: event-loop delay p99 ${loopBad ? red(loopTxt) : loopTxt}   load ${r.load1 > CPU_COUNT ? yellow(loadTxt) : loadTxt}${loopBad ? red("  OVERLOADED: latencies include local delay") : ""}`);
  if (TTY) process.stdout.write("\x1b[H\x1b[2J");
  else process.stdout.write("\n");
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
interface Check { name: string; ok: boolean; na?: boolean; value: string; threshold: string }
function verdict(): { pass: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const failPct = totalCalls ? (100 * totalFailures) / totalCalls : 0;
  checks.push({ name: "Failures (NETWORK/HTTP/5xx/timeouts) of all calls", ok: failPct < TH.maxFailPct || totalFailures === 0, value: `${totalFailures} of ${totalCalls} (${failPct.toFixed(3)}%)`, threshold: `< ${TH.maxFailPct}%` });
  for (const l of P95_CHECKED) {
    const s = cumStats.get(l);
    if (!s || s.n === 0) {
      const na = (l === "player_poll[ended]" || l === "player_poll[revealed]") && CFG.afterEndS === 0;
      checks.push({ name: `p95 ${l}`, ok: na, na, value: "no calls", threshold: `< ${TH.p95Ms} ms` });
      continue;
    }
    const p95 = pct(sorted(s.lat), 95)!;
    checks.push({ name: `p95 ${l}`, ok: p95 < TH.p95Ms, value: `${p95.toFixed(0)} ms (n=${s.n})`, threshold: `< ${TH.p95Ms} ms` });
  }
  const rtPct = claimsCreated ? (100 * rtInserts) / claimsCreated : 0;
  checks.push({ name: "Realtime claim events received", ok: claimsCreated > 0 && rtPct >= TH.rtMinPct, value: `${rtInserts} of ${claimsCreated} (${rtPct.toFixed(1)}%)`, threshold: `>= ${TH.rtMinPct}%` });
  const lag95 = pct(sorted(rtLagsAll), 95);
  checks.push({ name: "Realtime lag p95", ok: lag95 !== null && lag95 < TH.rtP95Ms, value: lag95 === null ? "no events" : `${lag95.toFixed(0)} ms`, threshold: `< ${TH.rtP95Ms} ms` });
  checks.push({ name: "All players joined", ok: bots.length === CFG.players, value: `${bots.length} of ${CFG.players}`, threshold: "all" });
  checks.push({ name: "Test machine kept up (event-loop delay p99)", ok: loopP99Peak < LOOP_LAG_MS, value: `peak ${loopP99Peak.toFixed(0)} ms, ${loopLagWindows} slow window(s)`, threshold: `< ${LOOP_LAG_MS} ms (if this fails, rerun from a faster machine or with fewer players per machine)` });
  if (aborted) checks.push({ name: "Run completed (not interrupted)", ok: false, value: "interrupted by Ctrl+C", threshold: "complete" });
  if (crashError) checks.push({ name: "Run completed (no crash)", ok: false, value: crashError, threshold: "complete" });
  return { pass: checks.every((x) => x.ok), checks };
}
let crashError: string | null = null;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function csvEscape(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}
function writeCsv() {
  const head = ["t_s", "phase", "joined", "active", "submitted", "req_s", "failures", "expected_errors"];
  for (const l of MAIN_LABELS) head.push(`${l}_n`, `${l}_p50_ms`, `${l}_p95_ms`);
  head.push("rt_events", "rt_lag_p95_ms", "conn_active", "conn_idle", "conn_waiting", "conn_total", "tx_s", "cache_hit_pct", "longest_active_s", "event_loop_p99_ms", "load1");
  const out = [head.join(",")];
  for (const r of rows) {
    const v: unknown[] = [r.t.toFixed(1), r.phase, r.joined, r.active, r.submitted, r.reqS.toFixed(1), r.failures, r.expected];
    for (const l of MAIN_LABELS) v.push(r.labels[l].n, r.labels[l].p50?.toFixed(0), r.labels[l].p95?.toFixed(0));
    v.push(r.rtEvents, r.rtLagP95?.toFixed(0), r.connActive, r.connIdle, r.connWaiting, r.connTotal, r.txS?.toFixed(1), r.cachePct?.toFixed(2), r.longestActive?.toFixed(2), r.loopP99.toFixed(0), r.load1.toFixed(2));
    out.push(v.map(csvEscape).join(","));
  }
  writeFileSync(pjoin(REPORT_PATH, "timeseries.csv"), out.join("\n") + "\n");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

interface Series { name: string; color: number; data: (number | null)[] }
function lineChart(title: string, unit: string, series: Series[], threshold?: { v: number; label: string }): string {
  const W = 640, H = 230, L = 52, R = 12, T = 14, B = 28;
  const xs = rows.map((r) => r.t);
  const xMax = Math.max(1, ...xs, ...markers.map((m) => m.t));
  let yMax = Math.max(0, ...series.flatMap((s) => s.data.filter((v): v is number => v !== null)), threshold ? threshold.v * 1.15 : 0);
  if (yMax <= 0) yMax = 1;
  const step = niceStep(yMax / 4);
  yMax = Math.ceil(yMax / step) * step;
  const X = (t: number) => L + (t / xMax) * (W - L - R);
  const Y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  const parts: string[] = [];
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="tick" x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${fmtTick(v)}</text>`);
  }
  const xStep = niceStep(xMax / 6);
  for (let t = 0; t <= xMax + 1e-9; t += xStep) {
    parts.push(`<text class="tick" x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="middle">${mmss(t)}</text>`);
  }
  for (const m of markers) {
    parts.push(`<line class="marker" x1="${X(m.t).toFixed(1)}" x2="${X(m.t).toFixed(1)}" y1="${T}" y2="${H - B}"/><text class="mlabel" x="${(X(m.t) + 3).toFixed(1)}" y="${T + 9}">${esc(m.label)}</text>`);
  }
  if (threshold) {
    parts.push(`<line class="thr" x1="${L}" x2="${W - R}" y1="${Y(threshold.v).toFixed(1)}" y2="${Y(threshold.v).toFixed(1)}"/><text class="mlabel" x="${W - R - 2}" y="${(Y(threshold.v) - 3).toFixed(1)}" text-anchor="end">${esc(threshold.label)}</text>`);
  }
  for (const s of series) {
    let d = "";
    let pen = false;
    let points = 0;
    s.data.forEach((v, i) => {
      if (v === null || v === undefined) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(xs[i]).toFixed(1)} ${Y(v).toFixed(1)}`;
      pen = true;
      points++;
    });
    if (points) parts.push(`<path class="line c${s.color}" d="${d}"/>`);
    if (points === 1) {
      const i = s.data.findIndex((v) => v !== null);
      parts.push(`<circle class="dot c${s.color}" cx="${X(xs[i]).toFixed(1)}" cy="${Y(s.data[i]!).toFixed(1)}" r="3"/>`);
    }
  }
  const empty = series.every((s) => s.data.every((v) => v === null));
  const legend = series.map((s) => `<span class="lg"><i class="sw c${s.color}"></i>${esc(s.name)}</span>`).join("");
  return `<figure class="card"><figcaption>${esc(title)} <span class="unit">${esc(unit)}</span></figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)} over time"><title>${esc(title)}</title>${parts.join("")}${empty ? `<text class="tick" x="${W / 2}" y="${H / 2}" text-anchor="middle">no data</text>` : ""}</svg>
<div class="legend">${legend}</div></figure>`;
}
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
function fmtTick(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(Math.round(v * 100) / 100);
}

function buildHtml(summary: Record<string, unknown>, v: ReturnType<typeof verdict>): string {
  const checkRows = v.checks
    .map((k) => `<tr><td>${esc(k.name)}</td><td>${esc(k.value)}</td><td>${esc(k.threshold)}</td><td class="${k.ok ? "pass" : "fail"}">${k.na ? "n/a" : k.ok ? "PASS" : "FAIL"}</td></tr>`)
    .join("");
  const rpcRows = [...cumStats.entries()].sort().map(([l, s]) => {
    const x = s.summary();
    return `<tr><td>${esc(l)}</td><td>${x.count}</td><td>${x.expected_errors}</td><td class="${x.failures ? "fail" : ""}">${x.failures}</td><td>${f0(x.p50)}</td><td>${f0(x.p95)}</td><td>${f0(x.p99)}</td><td>${f0(x.max)}</td></tr>`;
  }).join("");
  const phaseRows = [...phaseStats.entries()].sort().map(([k, s]) => {
    const [ph, l] = k.split("|");
    const x = s.summary();
    return `<tr><td>${esc(ph)}</td><td>${esc(l)}</td><td>${x.count}</td><td>${x.failures}</td><td>${f0(x.p50)}</td><td>${f0(x.p95)}</td><td>${f0(x.p99)}</td></tr>`;
  }).join("");
  const codeTotals = new Map<string, number>();
  for (const s of cumStats.values()) for (const [k, n] of s.codes) codeTotals.set(k, (codeTotals.get(k) ?? 0) + n);
  const codeRows = [...codeTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td>${EXPECTED.has(k) ? "expected" : "<b class=\"fail\">failure</b>"}</td><td>${n}</td></tr>`).join("");
  const charts = [
    lineChart("p95 latency per RPC", "ms", [
      { name: "join_session", color: 1, data: rows.map((r) => r.labels["join_session"].p95) },
      { name: "poll lobby", color: 7, data: rows.map((r) => r.labels["player_poll[lobby]"].p95) },
      { name: "poll live", color: 2, data: rows.map((r) => r.labels["player_poll[live]"].p95) },
      { name: "poll paused", color: 8, data: rows.map((r) => r.labels["player_poll[paused]"].p95) },
      { name: "poll ended", color: 3, data: rows.map((r) => r.labels["player_poll[ended]"].p95) },
      { name: "poll revealed", color: 9, data: rows.map((r) => r.labels["player_poll[revealed]"].p95) },
      { name: "create_claim", color: 4, data: rows.map((r) => r.labels["create_claim"].p95) },
      { name: "respond_claim", color: 5, data: rows.map((r) => r.labels["respond_claim"].p95) },
      { name: "submit_board", color: 6, data: rows.map((r) => r.labels["submit_board"].p95) },
    ], { v: TH.p95Ms, label: `limit ${TH.p95Ms} ms` }),
    lineChart("Requests per second (players)", "req/s", [{ name: "req/s", color: 1, data: rows.map((r) => r.reqS) }]),
    lineChart("Failures and expected errors per window", "count", [
      { name: "failures", color: 5, data: rows.map((r) => r.failures) },
      { name: "expected errors", color: 7, data: rows.map((r) => r.expected) },
    ]),
    lineChart("Realtime lag (claim created to event received), p95", "ms", [{ name: "lag p95", color: 4, data: rows.map((r) => r.rtLagP95) }], { v: TH.rtP95Ms, label: `limit ${TH.rtP95Ms} ms` }),
    lineChart("Database connections", "count", [
      { name: "active", color: 2, data: rows.map((r) => r.connActive) },
      { name: "idle", color: 1, data: rows.map((r) => r.connIdle) },
      { name: "waiting on locks", color: 5, data: rows.map((r) => r.connWaiting) },
      { name: "total", color: 7, data: rows.map((r) => r.connTotal) },
    ]),
    lineChart("Database transactions per second", "tx/s", [{ name: "tx/s", color: 3, data: rows.map((r) => r.txS) }]),
  ].join("\n");
  const cfgRows = Object.entries(summary.config as Record<string, unknown>).map(([k, val]) => `<tr><td>${esc(k)}</td><td>${esc(String(val))}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Load test ${esc(RUN_ID)}</title>
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#14181f;--muted:#5b6575;--grid:#e3e7ed;--border:#d7dce4;--good:#0b7a3b;--bad:#b42318;--goodbg:#e6f4ec;--badbg:#fdecea;
--c1:#2563eb;--c2:#d97706;--c3:#059669;--c4:#9333ea;--c5:#dc2626;--c6:#0891b2;--c7:#64748b;--c8:#be185d;--c9:#4d7c0f}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#171c23;--fg:#e8ebf0;--muted:#98a2b3;--grid:#262d38;--border:#2c3440;--good:#4ade80;--bad:#f87171;--goodbg:#10291a;--badbg:#321514;
--c1:#60a5fa;--c2:#fbbf24;--c3:#34d399;--c4:#c084fc;--c5:#f87171;--c6:#22d3ee;--c7:#94a3b8;--c8:#f472b6;--c9:#a3e635}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:.2em 0}h2{font-size:1.1rem;margin:1.6em 0 .5em}
.sub{color:var(--muted);margin:0 0 12px;overflow-wrap:anywhere}
.banner{padding:14px 16px;border-radius:10px;font-weight:700;font-size:1.2rem;border:1px solid var(--border)}
.banner.pass{background:var(--goodbg);color:var(--good)}.banner.fail{background:var(--badbg);color:var(--bad)}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--border);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--grid);white-space:nowrap}
th{color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}
td.pass,.pass{color:var(--good);font-weight:700}td.fail,.fail{color:var(--bad);font-weight:700}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:12px}
.card{margin:0;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px}
figcaption{font-weight:600;margin-bottom:4px}.unit{color:var(--muted);font-weight:400}
svg{width:100%;height:auto;display:block}
.grid{stroke:var(--grid);stroke-width:1}.tick{fill:var(--muted);font-size:11px}
.marker{stroke:var(--muted);stroke-dasharray:3 3;stroke-width:1}.thr{stroke:var(--bad);stroke-dasharray:6 3;stroke-width:1.2}
.mlabel{fill:var(--muted);font-size:10px}
.line{fill:none;stroke-width:2;stroke-linejoin:round}.dot{stroke:none}
.c1{stroke:var(--c1);fill:var(--c1)}.c2{stroke:var(--c2);fill:var(--c2)}.c3{stroke:var(--c3);fill:var(--c3)}.c4{stroke:var(--c4);fill:var(--c4)}
.c5{stroke:var(--c5);fill:var(--c5)}.c6{stroke:var(--c6);fill:var(--c6)}.c7{stroke:var(--c7);fill:var(--c7)}.c8{stroke:var(--c8);fill:var(--c8)}.c9{stroke:var(--c9);fill:var(--c9)}
.line.c1,.line.c2,.line.c3,.line.c4,.line.c5,.line.c6,.line.c7,.line.c8{fill:none}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.8rem;color:var(--muted);margin-top:4px}.sw{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle;fill:none}
.sw.c1{background:var(--c1)}.sw.c2{background:var(--c2)}.sw.c3{background:var(--c3)}.sw.c4{background:var(--c4)}.sw.c5{background:var(--c5)}.sw.c6{background:var(--c6)}.sw.c7{background:var(--c7)}.sw.c8{background:var(--c8)}.sw.c9{background:var(--c9)}
</style></head><body><main>
<h1>Load test report</h1>
<p class="sub">Run ${esc(RUN_ID)} on ${esc(HOST)}, session ${esc(sessionCode || "-")}, ${CFG.players} players, ${CFG.minutes} min live. Started ${esc(new Date(T0).toISOString())}.</p>
<div class="banner ${v.pass ? "pass" : "fail"}">${v.pass ? "PASS" : "FAIL"}${v.checks.filter((k) => !k.ok).length ? `: ${esc(v.checks.filter((k) => !k.ok).map((k) => k.name).join("; "))}` : ""}</div>
<h2>Verdict</h2><div class="tw"><table><thead><tr><th>Check</th><th>Result</th><th>Threshold</th><th></th></tr></thead><tbody>${checkRows}</tbody></table></div>
<h2>Over time</h2><div class="charts">${charts}</div>
<h2>Per RPC (whole run)</h2><div class="tw"><table><thead><tr><th>RPC</th><th>calls</th><th>expected err</th><th>failures</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>max ms</th></tr></thead><tbody>${rpcRows}</tbody></table></div>
<h2>Per phase</h2><div class="tw"><table><thead><tr><th>phase</th><th>RPC</th><th>calls</th><th>failures</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th></tr></thead><tbody>${phaseRows}</tbody></table></div>
<h2>Error codes</h2><div class="tw"><table><thead><tr><th>code</th><th>kind</th><th>count</th></tr></thead><tbody>${codeRows || "<tr><td colspan=3>none</td></tr>"}</tbody></table></div>
<h2>Config</h2><div class="tw"><table><tbody>${cfgRows}</tbody></table></div>
<p class="sub">Charts show 5 second windows. Dashed vertical lines mark phase changes. Expected errors (COWORKER_LIMIT, CELL_TAKEN, PAUSED, ...) are normal under random play; failures are NETWORK, HTTP/5xx and timeouts.</p>
</main></body></html>`;
}

function writeReport() {
  mkdirSync(REPORT_PATH, { recursive: true });
  const v = verdict();
  const lagS = sorted(rtLagsAll);
  const summary = {
    run_id: RUN_ID,
    host: HOST,
    session_code: sessionCode || null,
    started_at: new Date(T0).toISOString(),
    duration_s: Math.round(elapsedS()),
    config: { ...CFG, pauseAtS: CFG.pauseAtS ?? "none", session_duration_seconds: durationSeconds },
    totals: { calls: totalCalls, expected_errors: totalExpected, failures: totalFailures, failure_pct: totalCalls ? (100 * totalFailures) / totalCalls : 0, players_joined: bots.length, submitted: submittedCount },
    failure_codes: Object.fromEntries(failureSamples),
    per_rpc: Object.fromEntries([...cumStats.entries()].sort().map(([k, s]) => [k, s.summary()])),
    per_phase: Object.fromEntries([...phaseStats.entries()].sort().map(([k, s]) => [k, s.summary()])),
    realtime: { claims_created: claimsCreated, insert_events: rtInserts, update_events: rtUpdates, received_pct: claimsCreated ? (100 * rtInserts) / claimsCreated : null, lag_p50_ms: pct(lagS, 50), lag_p95_ms: pct(lagS, 95), lag_p99_ms: pct(lagS, 99), lag_max_ms: lagS.length ? lagS[lagS.length - 1] : null, clock_offset_ms: Math.round(clockOffsetMs) },
    db: { enabled: healthEnabled, peak: dbPeak, unavailable_stats: [...healthUnavailable], deadlocks_during_run: healthFirst && healthLast && healthLast.deadlocks !== undefined && healthFirst.deadlocks !== undefined ? healthLast.deadlocks - healthFirst.deadlocks : null, temp_bytes_during_run: healthFirst && healthLast && healthLast.temp_bytes !== undefined && healthFirst.temp_bytes !== undefined ? healthLast.temp_bytes - healthFirst.temp_bytes : null },
    load_generator: { cpus: CPU_COUNT, event_loop_p99_peak_ms: Math.round(loopP99Peak), slow_windows: loopLagWindows, threshold_ms: LOOP_LAG_MS },
    markers,
    cleanup: { session_deleted: sessionDeleted, kept: CFG.keep },
    aborted,
    error: crashError,
    thresholds: { ...TH, note: "PASS needs: failures < maxFailPct of calls; p95 < p95Ms for join_session, player_poll[live], create_claim, respond_claim, player_poll[ended]; realtime events >= rtMinPct with p95 lag < rtP95Ms; all players joined." },
    checks: v.checks,
    verdict: v.pass ? "PASS" : "FAIL",
  };
  writeFileSync(pjoin(REPORT_PATH, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeCsv();
  writeFileSync(pjoin(REPORT_PATH, "report.html"), buildHtml(summary, v));
  return { v, summary };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
let cleanupP: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleanupP ??= (async () => {
    botsStop = true;
    resolveStop();
    const prev = phase;
    if (channel) {
      try { await admin.removeChannel(channel); } catch { /* ignore */ }
    }
    if (!sessionId || !admin) return;
    phase = "cleanup";
    void prev;
    if (CFG.keep) {
      // Leave the data, but make sure the game is not left running.
      await admin.rpc("end_session", { p_session_id: sessionId });
      console.log(`Kept session ${sessionCode} (--keep). Delete it in the admin UI when done.`);
      return;
    }
    const del = await admin.from("sessions").delete().eq("id", sessionId);
    if (del.error) {
      sessionDeleted = false;
      console.error(`Cleanup FAILED: could not delete session ${sessionCode}: ${del.error.message}. Delete it in the admin UI.`);
      return;
    }
    const left = await admin.from("sessions").select("id").eq("id", sessionId);
    sessionDeleted = !left.error && (left.data ?? []).length === 0;
    console.log(sessionDeleted ? `Cleanup: session ${sessionCode} deleted (players, boards and claims cascade).` : `Cleanup: session ${sessionCode} still exists, delete it in the admin UI.`);
  })();
  return cleanupP;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function confirmTarget() {
  if (IS_LOCAL) return;
  const ref = HOST.split(".")[0];
  console.log(`Target: ${HOST} (project ref "${ref}")`);
  console.log("This creates ~" + CFG.players + " fake players and heavy traffic on that project. DO NOT run it during a real game.");
  if (flag("yes")) return;
  if (!process.stdin.isTTY) die("Not a terminal: pass --yes to confirm the target without typing the project ref.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type the project ref (${ref}) to continue: `)).trim();
  rl.close();
  if (answer !== ref) die("Project ref did not match. Aborting.");
}

async function run() {
  await confirmTarget();
  console.log(`Load E2E ${RUN_ID}: ${CFG.players} players, ${CFG.minutes} min live, ramp ${CFG.joinRampS}s -> ${HOST}`);
  admin = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(120_000) } });
  botSb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timeoutFetch(20_000) } });
  const si = await admin.auth.signInWithPassword({ email: ADMIN_EMAIL!, password: ADMIN_PASSWORD! });
  if (si.error) throw new Error(`Admin sign-in failed: ${si.error.message}`);

  // Is admin_db_health (migration 0016) available?
  const h0 = await admin.rpc("admin_db_health");
  if (h0.error) {
    healthEnabled = false;
    console.warn(`WARNING: admin_db_health() failed (${h0.error.message}). Apply migration 0016 for DB metrics. Continuing without them.`);
  } else {
    prevHealth = { h: h0.data as Health, at: nowMs() };
    healthFirst = h0.data as Health;
    for (const u of (h0.data as Health).unavailable ?? []) healthUnavailable.add(u);
    if (healthUnavailable.size) console.warn(`Note: these DB stats are not readable on this project: ${[...healthUnavailable].join(", ")}`);
  }

  // Clock offset (server minus local), using the lowest round trip of 5 samples.
  let best = Infinity;
  for (let k = 0; k < 5; k++) {
    const a = nowMs();
    const r = await admin.rpc("server_now");
    const b = nowMs();
    if (!r.error && typeof r.data === "string" && b - a < best) {
      best = b - a;
      clockOffsetMs = new Date(r.data).getTime() - (a + b) / 2;
    }
  }

  const prompts: string[] = [];
  for (let k = 0; k < CFG.prompts; k++) {
    const base = DEFAULT_PROMPTS[k % DEFAULT_PROMPTS.length];
    const round = Math.floor(k / DEFAULT_PROMPTS.length);
    prompts.push(round === 0 ? base : `${base} (${round + 1})`);
  }
  const created = await call<{ id: string; code: string }>(admin, "create_session", {
    p_name: `Load test ${new Date().toISOString()}`,
    p_duration_seconds: durationSeconds,
    p_ranking_mode: "correct_then_time",
    p_require_full_card: false,
    p_winners_count: 3,
    p_max_squares_per_coworker: 1,
    p_prompts: prompts,
    p_allowed_email_domains: [],
    p_lines_to_win: 1,
    p_allow_username_claims: true,
  }, "create_session");
  if (!created) throw new Error(`create_session failed: ${[...failureSamples.keys()].join(", ") || "see error codes"}`);
  sessionId = created.id;
  sessionCode = created.code;
  console.log(`Session ${sessionCode} created.`);

  // Realtime subscription like the admin dashboard (claims for this session).
  channel = admin
    .channel(`loadtest-${sessionId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "claims", filter: `session_id=eq.${sessionId}` }, (payload) => {
      if (payload.eventType === "INSERT") {
        rtInserts++;
        win.rtEvents++;
        const created = (payload.new as { created_at?: string }).created_at;
        if (created) {
          const lag = nowMs() + clockOffsetMs - new Date(created).getTime();
          rtLagsAll.push(lag);
          win.rtLags.push(lag);
        }
      } else if (payload.eventType === "UPDATE") rtUpdates++;
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") rtSubscribed = true;
    });
  for (let k = 0; k < 100 && !rtSubscribed && !aborted; k++) await sleep(100);
  if (!rtSubscribed && !aborted) throw new Error("Realtime channel did not subscribe within 10s");
  console.log("Realtime subscribed, warming up (6s)...");
  await sleep(6000);
  if (aborted) return;

  // Join phase
  T0 = nowMs();
  setPhase("join", "joins start");
  const timer = setInterval(() => void tick(), 5000);
  try {
    const offsets = Array.from({ length: CFG.players }, () => rand(0, CFG.joinRampS * 1000)).sort((a, b) => a - b);
    const lives = offsets.map((off, i) => runBot(i, off));
    // Wait for the ramp, then until every join has resolved.
    await sleep(CFG.joinRampS * 1000 + 2000);
    for (let k = 0; k < 150 && !aborted && joinResolved < CFG.players; k++) await sleep(200);
    if (aborted) return void (await finishBots(lives));
    setPhase("lobby", "all joined");
    console.log(`Joined ${bots.length}/${CFG.players}. Lobby for 5s, then start.`);
    await sleep(5000);
    if (aborted) return void (await finishBots(lives));

    const st = await call(admin, "start_session", { p_session_id: sessionId }, "start_session");
    if (st === null) throw new Error("start_session failed");
    liveStartMs = nowMs();
    setPhase("live", "start");

    // Live loop
    let pausedDone = CFG.pauseAtS === null;
    while (!aborted && activeElapsedMs() < CFG.minutes * 60_000) {
      await sleep(250);
      if (!pausedDone && !pausedSince && nowMs() - liveStartMs >= CFG.pauseAtS! * 1000) {
        if ((await call(admin, "pause_session", { p_session_id: sessionId }, "pause_session")) !== null) {
          pausedSince = nowMs();
          setPhase("paused", "pause");
        } else pausedDone = true;
      }
      if (pausedSince && nowMs() - pausedSince >= CFG.pauseS * 1000) {
        if ((await call(admin, "resume_session", { p_session_id: sessionId }, "resume_session")) !== null) {
          pausedTotalMs += nowMs() - pausedSince;
          pausedSince = 0;
          pausedDone = true;
          setPhase("live", "resume");
        }
      }
    }
    if (aborted) return void (await finishBots(lives));

    if (pausedSince) {
      await call(admin, "resume_session", { p_session_id: sessionId }, "resume_session");
      pausedTotalMs += nowMs() - pausedSince;
      pausedSince = 0;
    }
    await call(admin, "end_session", { p_session_id: sessionId }, "end_session");
    setPhase("ended", "end");
    console.log(`Game ended. Polling results for ${CFG.afterEndS}s...`);
    // Like the host: wait a moment on the "Time's up" screen, then press "Reveal winners", so the
    // test covers the moment every phone fetches its result at once.
    const revealAfterS = Math.min(20, CFG.afterEndS / 3);
    await sleep(revealAfterS * 1000);
    if (CFG.afterEndS > 0 && !aborted) {
      await call(admin, "admin_reveal_results", { p_session_id: sessionId }, "admin_reveal_results");
      markers.push({ t: elapsedS(), label: "reveal" });
    }
    await sleep(Math.max(0, CFG.afterEndS - revealAfterS) * 1000);
    await finishBots(lives);
  } finally {
    clearInterval(timer);
    await tick(); // final partial window
  }
}
async function finishBots(lives: Promise<void>[]) {
  botsStop = true;
  resolveStop();
  await Promise.race([Promise.allSettled(lives), new Promise((r) => setTimeout(r, 8000))]);
}

function onSignal() {
  if (aborted) {
    console.error("\nSecond interrupt: exiting now (session may remain, delete it in the admin UI).");
    process.exit(130);
  }
  aborted = true;
  botsStop = true;
  resolveAbort();
  resolveStop();
  console.error("\nInterrupted: stopping bots, cleaning up and writing the report...");
}
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

async function finalize() {
  try {
    await cleanup();
  } catch (e) {
    console.error(`Cleanup error: ${(e as Error).message}`);
  }
  let res;
  try {
    res = writeReport();
  } catch (e) {
    console.error(`Could not write the report: ${(e as Error).message}`);
    process.exit(1);
  }
  const { v, summary } = res;
  const rt = summary.realtime;
  console.log("\n==================== VERDICT ====================");
  for (const k of v.checks) console.log(`${k.ok ? green(k.na ? "n/a " : "PASS") : red("FAIL")}  ${k.name}: ${k.value} (limit ${k.threshold})`);
  console.log(`Peak DB connections ${dbPeak.conn_total}${dbPeak.max_connections ? `/${dbPeak.max_connections}` : ""}, peak lock waiters ${dbPeak.waiting_locks}, realtime lag p95 ${f0(rt.lag_p95_ms)}ms`);
  console.log(`\n${v.pass ? green(bold("PASS")) : red(bold("FAIL"))}`);
  console.log(`Report: ${pjoin(REPORT_PATH, "report.html")}`);
  process.exit(v.pass ? 0 : 1);
}

process.on("uncaughtException", (e) => {
  crashError = `uncaught: ${e.message}`;
  console.error(e);
  botsStop = true;
  resolveStop();
  void finalize();
});
process.on("unhandledRejection", (e) => {
  crashError = `unhandled rejection: ${(e as Error)?.message ?? String(e)}`;
  console.error(e);
  botsStop = true;
  resolveStop();
  void finalize();
});

run().then(
  () => finalize(),
  (e) => {
    crashError = (e as Error).message;
    console.error(`Run failed: ${crashError}`);
    return finalize();
  },
);
