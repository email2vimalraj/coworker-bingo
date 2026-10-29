import { describe, expect, it } from "vitest";
import { intervalFor } from "./pollInterval";
import type { PollResponse } from "./supabase/types";

function poll(
  status: "lobby" | "live" | "ended",
  opts: { submitted?: boolean; pending?: boolean; revealed?: boolean } = {},
) {
  return {
    session: { status, results_revealed: !!opts.revealed },
    me: { submitted_at: opts.submitted ? "2026-10-24T10:00:00Z" : null },
    board: [{ status: opts.pending ? "pending" : null }, { status: "confirmed" }],
  } as unknown as PollResponse;
}

describe("intervalFor", () => {
  it("live game: 3s normally", () => expect(intervalFor(poll("live"), false)).toBe(3000));
  it("live game: 1s while my QR is on screen", () => expect(intervalFor(poll("live"), true)).toBe(1000));
  it("live game: 1s while waiting for a coworker's answer", () =>
    expect(intervalFor(poll("live", { pending: true }), false)).toBe(1000));
  it("lobby: 3s, even with the QR showing", () => expect(intervalFor(poll("lobby"), true)).toBe(3000));
  it("submitted: 10s even with the QR showing", () =>
    expect(intervalFor(poll("live", { submitted: true }), true)).toBe(10000));
  it("ended, not yet revealed: 3s so phones flip quickly", () =>
    expect(intervalFor(poll("ended", { submitted: true }), true)).toBe(3000));
  it("ended and revealed: 10s", () => expect(intervalFor(poll("ended", { revealed: true }), true)).toBe(10000));
  it("no data yet: 10s", () => expect(intervalFor(null, true)).toBe(10000));
});
