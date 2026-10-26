# Coworker Bingo

A mobile-friendly "get to know your coworker" bingo for live events (450+ players), built for free tiers: Next.js 15 on Vercel Hobby, Supabase Free (Postgres, Auth for admins, Realtime for the admin dashboard only).

Players join a session by scanning a QR code, then fill squares by scanning coworkers who match a prompt. The coworker confirms on their own phone. Admins create sessions (time limit, ranking rules, winners), watch a live dashboard, and can delete sessions.

Players need no login: joining returns a secret `player_token` kept in localStorage, and every player action is a `SECURITY DEFINER` Postgres RPC called directly from the browser with the publishable key. Phones poll `player_poll(token)` every 3s, and every 1s while showing their own QR or waiting for a coworker's answer (see `lib/pollInterval.ts`).

## Deploy guide (Supabase + Vercel)

### 1. Supabase

1. Create a free project at https://supabase.com (note the database password and region).
2. SQL editor: run every file in `supabase/migrations/` in order (`0001_init.sql` … `0013_username_option.sql`), then optionally `supabase/seed.sql` (a demo session with code `DEMO23`). Each file runs as one transaction, so a failed run changes nothing. The files aren't idempotent: re-running one that already ran fails with errors like `type "session_status" already exists`. **Not sure what has run?** Run `supabase/check-migrations.sql`. It lists each file as applied or not; run only the missing ones, in order.
3. Authentication > Providers: make sure **Email** is enabled. For a small admin team, turn off "Allow new users to sign up" (Authentication > Sign In / Providers) so only users you create can log in.
4. Authentication > Users > Add user: create the admin (email + password, tick "Auto confirm user"). Then in the SQL editor:

   ```sql
   insert into admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```

   Only users in `admins` can use admin RPCs and read tables (`is_admin()`).
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
| `npm run load-test -- --session DEMO23 --players 450 --minutes 2` | 450 simulated players (start the session in the admin UI while it waits) |
| `npm run db:reset` | wipe the local DB and re-apply migration + seed (then re-run `npm run local:admin`) |
| `npm run db:stop` | stop the Docker containers |

Local extras: Supabase Studio (browse tables) at http://127.0.0.1:54323.

## Testing on localhost

- Open several **incognito/private windows** (or different browsers/profiles): each one is a separate player because the player token lives in localStorage. Admin in one normal window.
- Join each player with a distinct email (a duplicate email is rejected), start the game as admin, then on a player's board tap a square > **Enter code** and paste another player's code or type their username (the part of their email before the `@`, e.g. `player1`). Each player's code and username are shown on their lobby screen and `/play/CODE/me` with a copy button, so you do not need a camera.
- The camera scanner needs HTTPS (`localhost` only counts on the same machine). To test scanning with real phones use a Vercel preview URL (set `NEXT_PUBLIC_APP_URL` for that environment accordingly) or an HTTPS tunnel.
- `NEXT_PUBLIC_APP_URL` should match the URL players actually open, otherwise join QR codes point to the wrong host.

## Load test (staging only)

```bash
npm run load-test -- --url https://STAGING.supabase.co --key sb_publishable_... \
  --session ABC123 --players 450 --minutes 5
```

It joins N fake players (`loadtest+i@example.com`), polls `player_poll` every ~3s with jitter (`--poll-ms 1000` simulates the 1s worst case), makes claims on random open cells against random other players (targets accept ~80% on their next poll) and submits near the end. It prints per-RPC counts, p50/p95/p99 latency, and a histogram of error codes. Business errors like `COWORKER_LIMIT` or `CELL_TAKEN` are normal; watch for `NETWORK:*` / `HTTP/*` errors and p95 above ~500ms.

Steps: create a session in the admin UI on the **staging** project, run the script (it joins first, then waits), press **Start** in the admin UI while it runs, and let it finish. Optional flags: `--poll-ms`, `--claim-every-s`.

**Run it only against a separate staging Supabase project**, never the production one, and never at someone else's project: it creates hundreds of rows and generates real traffic. Clean up by deleting the session in the admin UI (or `delete from sessions where code = 'ABC123'`): players, boards and claims cascade.

## Event-day checklist

- [ ] **Wake the Supabase project the day before.** Free projects pause after 7 days of inactivity; open the dashboard and restore it if paused, then load the app once.
- [ ] Run the migration on the production project and confirm `select * from admins` has you.
- [ ] Run the load test on a staging project of the same plan and check p95 < 500ms and no `HTTP/*` errors.
- [ ] Vercel Hobby is for **non-commercial use** only. Confirm that an internal company event is acceptable, or use a paid plan.
- [ ] Verify `NEXT_PUBLIC_APP_URL`, Supabase Site URL / Redirect URLs, and that the join QR on the Present screen opens the right page on a phone (cellular and venue Wi-Fi).
- [ ] Do a 2-phone dress rehearsal on the production URL, then delete the rehearsal session.
- [ ] Project the **Present** page (`/admin/sessions/ID/present`), full-screen; keep one admin tab open on the dashboard.
- [ ] After the event: export the CSV, then delete the session to remove players' names and emails.

## Known limitations

- Supabase Free caps realtime at about 200 concurrent connections, so players do **not** use realtime; they poll `player_poll` every 3s, every 1s while their QR is on screen or a scan awaits an answer, and every 10s after submitting. Worst case (all 450 at 1s, `--poll-ms 1000`) ran locally at p95 6ms; re-check on the hosted project. Only admin screens (dashboard and present) use realtime, with a 10s polling fallback.
- A player's identity is a secret token in their browser; clearing site data or switching browsers means they cannot get back into the same player (they cannot rejoin with the same email either; an admin can delete the player row).
- Supabase Free allows no point-in-time recovery; export results at the end.

## Codes

- Session code: 6 chars, e.g. `K7PQ2X`. Player code: `XXX-XXX`. Alphabet excludes `0 O 1 I L`.
- `create_claim` accepts the coworker code case-insensitively, with or without the dash, or a full URL containing `c=<code>`. Parsing is done in SQL (`normalize_player_code`) and mirrored in `lib/codes.ts`, so the client can pass raw scanner output.
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
