"use client";
import { useSyncExternalStore } from "react";

const KEY = "bingo-request-popups";
const listeners = new Set<() => void>();

/** Show incoming requests as an automatic pop-up (default on). */
export function getRequestPopups(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setRequestPopups(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useRequestPopups(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, getRequestPopups, () => true);
  return [on, setRequestPopups];
}
