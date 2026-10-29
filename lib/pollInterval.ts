import type { PollResponse } from "./supabase/types";

const BOOST_MS = 1000; // showing my QR, or waiting for a coworker to answer
const FAST_MS = 3000; // live game, lobby
const SLOW_MS = 10000; // submitted, ended

/** How long to wait before the next player_poll. See usePlayerPoll. */
export function intervalFor(d: PollResponse | null, boost: boolean): number {
  if (!d) return SLOW_MS;
  // Ended: poll quickly until the host reveals, so phones flip soon after; then slow down.
  if (d.session.status === "ended") return d.session.results_revealed ? SLOW_MS : FAST_MS;
  if (d.me.submitted_at) return SLOW_MS;
  if (d.session.status === "lobby") return FAST_MS; // notice "Start" within ~3s
  const waitingForAnswer = d.board.some((c) => c.status === "pending");
  return boost || waitingForAnswer ? BOOST_MS : FAST_MS;
}
