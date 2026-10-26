/** Confetti helpers. Silent no-ops under prefers-reduced-motion or on the server. */
export type ConfettiPower = "small" | "big" | "finale";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export async function burst(power: ConfettiPower = "small"): Promise<void> {
  if (typeof window === "undefined" || prefersReducedMotion()) return;
  const confetti = (await import("canvas-confetti")).default;
  const base = { disableForReducedMotion: true, zIndex: 100 };
  if (power === "small") {
    void confetti({ ...base, particleCount: 90, spread: 70, origin: { y: 0.6 } });
    return;
  }
  const count = power === "finale" ? 220 : 140;
  void confetti({ ...base, particleCount: count, spread: 100, origin: { x: 0.2, y: 0.7 }, angle: 60 });
  void confetti({ ...base, particleCount: count, spread: 100, origin: { x: 0.8, y: 0.7 }, angle: 120 });
  if (power === "finale") {
    window.setTimeout(() => void confetti({ ...base, particleCount: 200, spread: 160, origin: { y: 0.3 } }), 350);
  }
}
