/**
 * Vibration and synthesised sound alerts (no audio files).
 * Vibration: Android Chrome only (iOS Safari has no Vibration API; calls are no-ops).
 * Sound: Web Audio, must be unlocked by a user gesture (see unlockAudio / useAlerts).
 */
export type ToneKind = "incoming" | "confirmed" | "rejected" | "warning";

const PREF_KEY = "bingo-alerts-enabled";
const listeners = new Set<() => void>();

export function getAlertsEnabled(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAlertsEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function subscribeAlertsPref(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(pattern);
  } catch {
    /* unsupported */
  }
}

type AudioSessionNav = Navigator & { audioSession?: { type: string } };
type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** Call inside a user gesture. Creates/resumes the AudioContext and plays a silent buffer. */
export function unlockAudio(): void {
  try {
    // "ambient" respects the iPhone silent switch instead of overriding it.
    const nav = navigator as AudioSessionNav;
    if (nav.audioSession) nav.audioSession.type = "ambient";
  } catch {
    /* ignore */
  }
  const c = getCtx();
  if (!c) return;
  void c.resume?.().catch(() => {});
  try {
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22050);
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* ignore */
  }
}

const SEQUENCES: Record<ToneKind, { f: number; at: number; dur: number; type?: OscillatorType }[]> = {
  incoming: [
    { f: 659, at: 0, dur: 0.16 },
    { f: 880, at: 0.18, dur: 0.22 },
  ],
  confirmed: [
    { f: 523, at: 0, dur: 0.1 },
    { f: 659, at: 0.1, dur: 0.1 },
    { f: 784, at: 0.2, dur: 0.1 },
    { f: 1047, at: 0.3, dur: 0.25 },
  ],
  rejected: [{ f: 196, at: 0, dur: 0.35, type: "triangle" }],
  warning: [
    { f: 988, at: 0, dur: 0.15, type: "square" },
    { f: 988, at: 0.25, dur: 0.15, type: "square" },
    { f: 988, at: 0.5, dur: 0.15, type: "square" },
  ],
};

export function playTone(kind: ToneKind): void {
  const c = getCtx();
  if (!c || c.state !== "running") return;
  const t0 = c.currentTime;
  for (const n of SEQUENCES[kind]) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.value = n.f;
    const peak = n.type === "square" ? 0.08 : 0.25;
    gain.gain.setValueAtTime(0, t0 + n.at);
    gain.gain.linearRampToValueAtTime(peak, t0 + n.at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + n.at + n.dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.02);
  }
}

const PATTERNS: Record<ToneKind, number | number[]> = {
  incoming: [200, 100, 200],
  confirmed: 80,
  rejected: [60, 40, 60],
  warning: [300, 100, 300],
};

/** Vibrate + tone for an event, honouring the user's on/off preference. */
export function notify(kind: ToneKind): void {
  if (!getAlertsEnabled()) return;
  vibrate(PATTERNS[kind]);
  playTone(kind);
}
