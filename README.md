# Coworker Bingo

A mobile-friendly "get to know your coworker" bingo for live events (450+ players), built for free tiers: Next.js 15 on Vercel Hobby, Supabase Free (Postgres, Auth for admins, Realtime for the admin dashboard only).

Players join a session by scanning a QR code, then fill squares by scanning coworkers who match a prompt. The coworker confirms on their own phone. Admins create sessions (time limit, ranking rules, winners), watch a live dashboard, and can delete sessions.

Players need no login: joining returns a secret `player_token` kept in localStorage, and every player action is a `SECURITY DEFINER` Postgres RPC called directly from the browser with the publishable key. Phones poll `player_poll(token)` every 3s, and every 1s while showing their own QR or waiting for a coworker's answer (see `lib/pollInterval.ts`).

## Deploy guide (Supabase + Vercel)

### 1. Supabase

1. Create a free project at https://supabase.com (note the database password and region).
2. SQL editor: run every file in `supabase/migrations/` in order (`0001_init.sql` … `0018_reveal_results.sql`), then optionally `supabase/seed.sql` (a demo session with code `DEMO23`). Each file runs as one transaction, so a failed run changes nothing. The files aren't idempotent: re-running one that already ran fails with errors like `type "session_status" already exists`. **Not sure what has run?** Run `supabase/check-migrations.sql`. It lists each file as applied or not; run only the missing ones, in order.
3. Authentication > Providers: make sure **Email** is enabled. Sign-ups can stay turned off ("Allow new users to sign up" under Authentication > Sign In / Providers): the app never uses them, and email confirmation is not needed.
4. Authentication > Users > Add user: create the admin (email + password, tick "Auto confirm user"). Then in the SQL editor:

   ```sql
   insert into admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```

   Only users in `admins` can use admin RPCs and read tables (`is_admin()`). Further admins are added from the **Admins** page: enter their email and a temporary password (migration 0015, `admin_create`, creates a confirmed account directly in SQL, no service-role key). Share the password privately; they can change it on the same page. If the account already exists, the password is ignored.
5. Project Settings > API: copy the **Project URL** and the **anon public** key. Never put the `service_role` key in this app.

### 2. Vercel

1. Push this repo to GitHub, then Vercel > Add New > Project > import it (framework: Next.js, defaults are fine).
2. Environment variables (Production and Preview):

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL, `https://<project-ref>.supabase.co` (Supabase: **Connect** button at the top of the project, or Settings > Data API) |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key `sb_publishable_...` (Settings > API Keys). The legacy anon key also works, under this name or `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Never use the secret key (`sb_secret_...`) here: the app doesn't need it. |
   | `NEXT_PUBLIC_APP_URL` | your production URL, e.g. `https://coworker-bingo.vercel.app` (used in join QR codes) |

3. Deploy. Then go back to Supabase > Authentication > URL Configuration: set **Site URL** to the production URL and add `https://<your-app>.vercel.app/**` (and any preview/custom domain you use) under **Redirect URLs**.
4. Open `/admin/login`, sign in, create a session, open **Present** on the projector.

### 3. Local development (fully local, no cloud account needed)

Needs Docker running (allow it a few GB of free disk). The Supabase CLI comes from `devDependencies`.

```bash
npm install
npm run db:start      # starts local Supabase in Docker; applies the migration + seed (demo session DEMO23)
npm run local:admin   # creates admin@local.test / admin12345 (optional args: email password)
```

Create `.env.local` with the values `npm run db:start` prints (the local keys are the same public defaults for everyone):

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_KEY from db:start>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Then `npm run dev` and open http://localhost:3000.

| Command | What it does |
|---|---|
| `npm run e2e:local` | 39 end-to-end checks against the local Supabase: every RPC, security rules, realtime, ranking, delete |
| `npm run load:e2e -- ...` | automated end-to-end load test with live view and report (see Load test) |
| `npm run load-test -- --session DEMO23 --players 450 --minutes 2` | older player-only simulation (you create/start the session in the admin UI) |
| `npm run db:reset` | wipe the local DB and re-apply migration + seed (then re-run `npm run local:admin`) |
| `npm run db:stop` | stop the Docker containers |

Local extras: Supabase Studio (browse tables) at http://127.0.0.1:54323.

## Testing on localhost

- Open several **incognito/private windows** (or different browsers/profiles): each one is a separate player because the player token lives in localStorage. Admin in one normal window.
- Join each player with a distinct email (a duplicate email is rejected), start the game as admin, then on a player's board tap a square > **Enter code** and paste another player's code or type their username (the part of their email before the `@`, e.g. `player1`). Each player's code and username are shown on their lobby screen and `/play/CODE/me` with a copy button, so you do not need a camera.
- The camera scanner needs HTTPS (`localhost` only counts on the same machine). To test scanning with real phones use a Vercel preview URL (set `NEXT_PUBLIC_APP_URL` for that environment accordingly) or an HTTPS tunnel.
- `NEXT_PUBLIC_APP_URL` should match the URL players actually open, otherwise join QR codes point to the wrong host.

## Load test

`npm run load:e2e` is a one-command, fully automated test: it signs in as an admin, creates a session, joins N bots over a ramp, starts the game, simulates play, optionally pauses/resumes, ends the game, keeps polling the results, deletes the session and writes a report. Apply migration `0016_admin_db_health.sql` first (without it the test still runs, but with no database metrics).

```bash
export LOADTEST_ADMIN_EMAIL=you@company.com LOADTEST_ADMIN_PASSWORD=...   # env only, never flags
npm run load:e2e -- --url https://PROJECT.supabase.co --key sb_publishable_... \
  --players 470 --minutes 5
```

- **Credentials:** the admin login comes only from the two env vars and is never logged. Use the publishable key; a secret/service-role key is refused.
- **Confirmation:** for any host other than localhost the script prints the project ref and asks you to type it (or pass `--yes`).
- **Do not run it during a real game.** It creates ~470 fake players and real traffic on the project. Run it from a wired connection (Wi-Fi hiccups show up as failures). On a Mac, 470 bots plus TLS use a lot of CPU in one process; if the Mac is the bottleneck, latencies rise on the client side only. Check Activity Monitor.
- **Flags** (defaults): `--players 470`, `--minutes 5` (live play time), `--join-ramp-s 60`, `--prompts 24`, `--pause-at-s N` with `--pause-s 30`, `--after-end-s 60`, `--qr-open-pct 15` (players polling at 1s), `--claim-every-s 20`, `--keep` (do not delete the session), `--report-dir load-reports`, `--yes`. Threshold flags: `--max-fail-pct 0.1`, `--p95-ms 500`, `--rt-min-pct 99`, `--rt-p95-ms 5000`.
- **Live view (every 5s):** phase and time, players joined/active/submitted, req/s, p50/p95 per RPC for the last window, failures (red when above 0), expected errors, realtime events received vs claims created and lag p95, and database connections (active/idle/waiting), tx/s, cache hit %, longest running query. Slow p95 (over the limit), lock waiters and lag over the limit are shown in red.
- **Report:** `load-reports/<runid>/` (git-ignored) holds `summary.json` (config without credentials, totals, per-RPC and per-phase stats, thresholds, verdict), `timeseries.csv` (one row per 5s window) and `report.html` (open it in a browser: verdict table, charts of p95 per RPC, req/s, failures, realtime lag, connections and tx/s with phase markers, then the tables).
- **PASS means all of:** failures (NETWORK, HTTP/5xx, timeouts) below 0.1% of all calls; p95 below 500 ms for `join_session`, `player_poll[live]`, `create_claim`, `respond_claim`, `player_poll[ended]` (after the end, before the reveal) and `player_poll[revealed]` (after the script presses Reveal winners, a third of the way into `--after-end-s` and at most 20 s in: every phone fetches its result at once); at least 99% of claim INSERT events received by the admin realtime subscription with p95 lag below 5 s; all N players joined. Exit code 0 on PASS, 1 on FAIL. Business errors such as `COWORKER_LIMIT`, `CELL_TAKEN`, `PAUSED` are "expected" and not failures.
- **Cleanup:** the session is deleted at the end (players, boards and claims cascade) and the script checks that it is gone. Ctrl+C stops the bots, cleans up and still writes the report (verdict FAIL, marked interrupted); a second Ctrl+C exits at once. If cleanup ever fails the script says so: delete the session named `Load test ...` in the admin UI.
- **Database stats:** come from the admin-only `admin_db_health()` RPC (aggregate numbers only). If the hosted role cannot read a view, that part is skipped and listed in `summary.json` under `db.unavailable_stats`.

`npm run load-test` (`scripts/load-test.ts`) still works as the older player-only simulation against a session you create and start yourself.

## Event-day checklist

- [ ] **Wake the Supabase project the day before.** Free projects pause after 7 days of inactivity; open the dashboard and restore it if paused, then load the app once.
- [ ] Run the migration on the production project and confirm `select * from admins` has you.
- [ ] Run `npm run load:e2e` (not on the day of a real game) and check it ends in PASS.
- [ ] Vercel Hobby is for **non-commercial use** only. Confirm that an internal company event is acceptable, or use a paid plan.
- [ ] Verify `NEXT_PUBLIC_APP_URL`, Supabase Site URL / Redirect URLs, and that the join QR on the Present screen opens the right page on a phone (cellular and venue Wi-Fi).
- [ ] Do a 2-phone dress rehearsal on the production URL, then delete the rehearsal session.
- [ ] Project the **Present** page (`/admin/sessions/ID/present`), full-screen; keep one admin tab open on the dashboard. The live Top 10 on the projector is off by default (totals only, so the winners stay a surprise); turn on "Show live Top 10 on the Present screen" on the dashboard if you want it.
- [ ] **After time is up, press "Reveal winners"** on the dashboard. Until then phones show "Time's up! Winners will be revealed on the big screen" and the projector shows "Winners coming up" (no names). Turning on the live Top 10 skips this and reveals results as soon as the game ends.
- [ ] After the event: export the CSV, then delete the session to remove players' names and emails.

## Known limitations

- Supabase Free caps realtime at about 200 concurrent connections, so players do **not** use realtime; they poll `player_poll` every 3s, every 1s while their QR is on screen or a scan awaits an answer, every 10s after submitting, and every 3s after the end until the host reveals the winners (then 10s). Worst case (all 450 at 1s, `--poll-ms 1000`) ran locally at p95 6ms; re-check on the hosted project. Only admin screens (dashboard and present) use realtime, with a 10s polling fallback.
- A player's identity is a secret token in their browser; clearing site data or switching browsers means they cannot get back into the same player (they cannot rejoin with the same email either; an admin can delete the player row).
- Supabase Free allows no point-in-time recovery; export results at the end.

## Codes

- Session code: 6 chars, e.g. `K7PQ2X`. Player code: `XXX-XXX`. Alphabet excludes `0 O 1 I L`.
- `create_claim` accepts the coworker code case-insensitively, with or without the dash, or a full URL containing `c=<code>`. Parsing is done in SQL (`normalize_player_code`) and mirrored in `lib/codes.ts`, so the client can pass raw scanner output.
- **Prompt pool (migration 0014):** a session has 24 to 200 prompts (case-insensitive duplicates raise `DUPLICATE_PROMPT`). Each player gets a random 24 of them, in random order, around the FREE centre (`join_session`). Editing the prompts in the lobby replaces the pool and rebuilds every joined player's board. `session_stats` reports `boards_count` per prompt.
- `create_claim` also accepts the coworker's username (email before `@`, case-insensitive) or full email. Resolution order in `_resolve_coworker`: code, then full email (if it contains `@`), then username. A username shared by several players raises `USERNAME_AMBIGUOUS`. Admins can switch username/email lookup off per session (`sessions.allow_username_claims`, migration 0013, checkbox in the session form); when off, only a player code or QR URL works and everything else is `COWORKER_NOT_FOUND`.
- QR content: `{origin}/play/{sessionCode}/scan?c={playerCode}`.

## RPCs

Player (anon): `join_session`, `player_poll`, `create_claim`, `respond_claim`, `cancel_claim`, `submit_board`.
Admin (authenticated + `is_admin()`): `create_session`, `start_session`, `end_session`, `session_leaderboard`, `session_activity`, plus `server_now()` for the admin clock offset. Deleting a session is a normal table delete (cascades).

Errors are raised as the exception message: `INVALID_INPUT`, `EMAIL_TAKEN`, `SESSION_NOT_FOUND`, `SESSION_ENDED`, `NOT_LIVE`, `TIME_UP`, `ALREADY_SUBMITTED`, `SELF_SCAN`, `COWORKER_NOT_FOUND`, `USERNAME_AMBIGUOUS`, `COWORKER_LIMIT`, `CELL_TAKEN`, `NOT_YOURS`, `INVALID_TOKEN`, `CLAIM_NOT_FOUND`, `CLAIM_NOT_PENDING`, `NOT_ADMIN`, `PROMPT_COUNT`, `ALREADY_STARTED`, `CODE_GENERATION_FAILED`.

## Ranking

See `lib/ranking.ts` (identical to the SQL `_leaderboard`): correct squares desc, then elapsed asc (non-submitters get the full duration); `full_card_fastest` ranks only 24/24 boards; `require_full_card` limits winners to 24/24; a player needs at least 1 confirmed square to be eligible to win in every mode; ties share a rank; `joined_at` is the final ordering tiebreak.

## Tests

```bash
npm test          # vitest: ranking and code helpers
npm run test:db   # runs the migration in PGlite (in-process Postgres) with a stubbed Supabase auth schema
npm run typecheck
npm run lint
```

## Security notes

- `anon` has no table privileges; RLS is enabled on every table. Admins read/write through `is_admin()` policies.
- `player_token` is a bearer secret: it is returned only by `join_session` to the joining browser. `authenticated` (admins) has column-level select on `players` that excludes it, `player_poll` and the leaderboard never return it.
- All `SECURITY DEFINER` functions set `search_path`; execute is revoked from `public`/`anon` and re-granted per function (admin RPCs only to `authenticated`, and they check `is_admin()` again).
- Claims serialize on the scanner's `players` row (`FOR UPDATE`) in `create_claim`, `respond_claim`, `cancel_claim` and `submit_board` (same lock order, no deadlocks), and a partial unique index guarantees one active claim per cell.
- Limits: name 80, email 254, prompt 120 characters.
