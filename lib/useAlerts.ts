"use client";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { getAlertsEnabled, notify, setAlertsEnabled, subscribeAlertsPref, unlockAudio } from "./alerts";
import { diffPolls, type PollSnapshot } from "./pollEvents";

/** [enabled, setEnabled] for the sound/vibration preference (default on). */
export function useAlertsEnabled(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeAlertsPref, getAlertsEnabled, () => true);
  return [on, setAlertsEnabled];
}

/** Unlocks audio on the first user gesture and fires alerts for changes between polls. */
export function useAlerts(snapshot: PollSnapshot | null): void {
  const prev = useRef<PollSnapshot | null>(null);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    const events = ["pointerdown", "touchend", "keydown"] as const;
    const handler = () => {
      unlockAudio();
      events.forEach((e) => window.removeEventListener(e, handler));
    };
    events.forEach((e) => window.addEventListener(e, handler, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, handler));
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const before = prev.current;
    prev.current = snapshot;
    if (!before) {
      // First poll after load: remember, don't alert.
      snapshot.incoming.forEach((i) => seen.current.add(i.claim_id));
      return;
    }
    const ev = diffPolls(before, snapshot, seen.current);
    snapshot.incoming.forEach((i) => seen.current.add(i.claim_id));
    if (ev.newIncoming.length) notify("incoming");
    else if (ev.confirmed.length) notify("confirmed");
    else if (ev.rejected.length) notify("rejected");
  }, [snapshot]);
}
