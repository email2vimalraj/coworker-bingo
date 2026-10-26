import { describe, expect, it } from "vitest";
import { buildRules, type RulesInput } from "./rules";

const base: RulesInput = {
  duration_seconds: 900,
  max_squares_per_coworker: 1,
  winners_count: 3,
  ranking_mode: "correct_then_time",
  lines_to_win: 1,
  require_full_card: false,
  allow_username_claims: true,
};
const text = (s: RulesInput) => buildRules(s).flatMap((x) => [x.heading, ...x.items]).join("\n");

describe("buildRules", () => {
  it("mentions username only when allowed", () => {
    expect(text(base)).toContain("username");
    expect(text({ ...base, allow_username_claims: false })).not.toContain("username");
  });
  it("uses the session numbers", () => {
    const t = text({ ...base, max_squares_per_coworker: 2, winners_count: 1 });
    expect(t).toContain("15 minutes");
    expect(t).toContain("up to 2 squares");
    expect(t).toContain("There is 1 winner");
    expect(text(base)).toContain("up to 1 square.");
  });
  it("describes lines mode", () => {
    const t = text({ ...base, ranking_mode: "lines", lines_to_win: 3 });
    expect(t).toContain("Complete 3 lines");
  });
  it("describes full card modes", () => {
    expect(text({ ...base, ranking_mode: "full_card_fastest" })).toContain("fastest full card");
    expect(text({ ...base, require_full_card: true })).toContain("Only full cards");
    expect(text(base)).not.toContain("Only full cards");
  });
  it("mentions early submission for time tie-breaks", () => {
    expect(text(base)).toContain("submitting early helps");
  });
});
