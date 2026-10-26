import { describe, expect, it } from "vitest";
import { barPercent, formatPercent, formatSeconds, highlightPrompts, peopleCsv, promptsCsv } from "./stats";

describe("stats helpers", () => {
  it("formats percent", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(0.4567)).toBe("45.7%");
  });
  it("formats seconds", () => {
    expect(formatSeconds(null)).toBe("—");
    expect(formatSeconds(75.4)).toBe("1:15");
    expect(formatSeconds(3725)).toBe("1:02:05");
  });
  it("bar percent", () => {
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(10, 10)).toBe(100);
    expect(barPercent(1, 1000)).toBe(2);
  });
  it("highlights top and bottom 5 without overlap", () => {
    const h = highlightPrompts(Array.from({ length: 24 }, (_, i) => i));
    expect(h.filter((x) => x === "top")).toHaveLength(5);
    expect(h.filter((x) => x === "bottom")).toHaveLength(5);
    expect(h[0]).toBe("top");
    expect(h[23]).toBe("bottom");
    const small = highlightPrompts([1, 2, 3, 4, 5, 6, 7]);
    expect(small.filter((x) => x === "top")).toHaveLength(5);
    expect(small.filter((x) => x === "bottom")).toHaveLength(2);
    expect(highlightPrompts([])).toEqual([]);
  });
  it("builds CSVs with escaping", () => {
    const csv = promptsCsv([
      { prompt_id: "a", text: 'Has "a" dog, cat', position: 0, found_count: 3, rejected_count: 1, rejection_rate: 0.25 },
    ]);
    expect(csv).toBe('Prompt,Found (confirmed),Rejected,Rejection rate\r\n"Has ""a"" dog, cat",3,1,25%');
    expect(peopleCsv([{ name: "=Evil", connections: 4, times_confirmed_for_others: 2 }])).toContain("1,'=Evil,4,2");
  });
});
