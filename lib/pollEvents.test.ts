import { describe, expect, it } from "vitest";
import { diffPolls } from "./pollEvents";

const cell = (i: number, status: "pending" | "confirmed" | null, last_outcome: "rejected" | "expired" | "revoked" | null = null) => ({
  cell_index: i,
  status,
  last_outcome,
});

describe("diffPolls", () => {
  it("detects new incoming requests only once", () => {
    const prev = { board: [], incoming: [{ claim_id: "a" }] };
    const next = { board: [], incoming: [{ claim_id: "a" }, { claim_id: "b" }] };
    expect(diffPolls(prev, next, new Set(["a"])).newIncoming).toEqual(["b"]);
    expect(diffPolls(next, next, new Set(["a", "b"])).newIncoming).toEqual([]);
  });
  it("detects pending -> confirmed", () => {
    const e = diffPolls(
      { board: [cell(3, "pending"), cell(4, null)], incoming: [] },
      { board: [cell(3, "confirmed"), cell(4, null)], incoming: [] },
      new Set(),
    );
    expect(e.confirmed).toEqual([3]);
    expect(e.rejected).toEqual([]);
  });
  it("detects pending -> rejected/expired", () => {
    const e = diffPolls(
      { board: [cell(1, "pending"), cell(2, "pending")], incoming: [] },
      { board: [cell(1, null, "rejected"), cell(2, null, "expired")], incoming: [] },
      new Set(),
    );
    expect(e.rejected).toEqual([1, 2]);
  });
  it("does not announce a host-removed (revoked) square as a rejection", () => {
    const e = diffPolls(
      { board: [cell(1, "confirmed")], incoming: [] },
      { board: [cell(1, null, "revoked")], incoming: [] },
      new Set(),
    );
    expect(e).toEqual({ newIncoming: [], confirmed: [], rejected: [] });
  });
  it("ignores cells that were not pending, and pending -> pending", () => {
    const e = diffPolls(
      { board: [cell(1, null, "rejected"), cell(2, "pending")], incoming: [] },
      { board: [cell(1, null, "rejected"), cell(2, "pending")], incoming: [] },
      new Set(),
    );
    expect(e).toEqual({ newIncoming: [], confirmed: [], rejected: [] });
  });
});
