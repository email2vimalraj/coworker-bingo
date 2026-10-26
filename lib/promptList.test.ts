import { describe, expect, it } from "vitest";
import { appendPrompts, duplicateIndexes, parsePromptLines, promptProblems } from "./promptList";

const many = (n: number) => Array.from({ length: n }, (_, i) => `Prompt ${i}`);

describe("duplicateIndexes", () => {
  it("flags case-insensitive repeats after trim, ignores blanks", () => {
    expect([...duplicateIndexes(["A", " a ", "b", "", ""])].sort()).toEqual([0, 1]);
  });
  it("is empty when all differ", () => expect(duplicateIndexes(["a", "b"]).size).toBe(0));
});

describe("parsePromptLines", () => {
  it("trims, skips blanks and repeats, handles CRLF", () => {
    expect(parsePromptLines("a\r\n\n  b \nA\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("appendPrompts", () => {
  it("fills blank rows first, then appends, skipping existing", () => {
    const r = appendPrompts(["x", "", "y"], ["Y", "z", "w"]);
    expect(r.list).toEqual(["x", "z", "y", "w"]);
    expect(r).toMatchObject({ added: 2, skipped: 1 });
  });
  it("caps at 200", () => {
    const r = appendPrompts(many(199), ["n1", "n2"]);
    expect(r.list).toHaveLength(200);
    expect(r).toMatchObject({ added: 1, skipped: 1 });
  });
});

describe("promptProblems", () => {
  it("accepts 24 and 200", () => {
    expect(promptProblems(many(24))).toEqual([]);
    expect(promptProblems(many(200))).toEqual([]);
  });
  it("rejects too few, too many, empty, long, duplicate", () => {
    expect(promptProblems(many(23))).toHaveLength(1);
    expect(promptProblems(many(201))).toHaveLength(1);
    expect(promptProblems([...many(23), " "])).toHaveLength(1);
    expect(promptProblems([...many(23), "x".repeat(121)])).toHaveLength(1);
    expect(promptProblems([...many(23), "prompt 1"])).toHaveLength(1);
  });
});
