"use client";
import { useEffect, useRef, useState } from "react";

/** Camera QR scanner (qr-scanner). Calls onResult with the raw decoded text. */
export function Scanner({
  onResult,
  paused = false,
}: {
  onResult: (text: string) => void;
  paused?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let scanner: { start: () => Promise<void>; stop: () => void; destroy: () => void } | null = null;
    let cancelled = false;

    async function init() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError(
          "The camera needs a secure (HTTPS) connection. Enter your coworker's code below instead.",
        );
        setStarting(false);
        return;
      }
      try {
        const QrScanner = (await import("qr-scanner")).default;
        if (!(await QrScanner.hasCamera())) {
          if (!cancelled) setError("No camera found. Enter your coworker's code below instead.");
          return;
        }
        if (cancelled || !videoRef.current) return;
        const s = new QrScanner(
          videoRef.current,
          (result) => {
            if (pausedRef.current) return;
            onResultRef.current(result.data);
          },
          {
            preferredCamera: "environment",
            highlightScanRegion: true,
            highlightCodeOutline: true,
            returnDetailedScanResult: true,
            maxScansPerSecond: 8,
          },
        );
        scanner = s;
        await s.start();
        if (cancelled) {
          s.stop();
          s.destroy();
        }
      } catch (e) {
        if (cancelled) return;
        const name = e instanceof Error ? e.name : String(e);
        const msg = typeof e === "string" ? e : "";
        if (name === "NotAllowedError" || /denied|permission/i.test(msg)) {
          setError(
            "Camera access was blocked. Allow the camera in your browser settings, or enter the code below.",
          );
        } else {
          setError("Couldn't start the camera. Enter your coworker's code below instead.");
        }
      } finally {
        if (!cancelled) setStarting(false);
      }
    }
    void init();

    return () => {
      cancelled = true;
      if (scanner) {
        scanner.stop();
        scanner.destroy();
      }
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm font-medium text-amber-900">
        {error}
      </div>
    );
  }
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-slate-900">
      <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
      {starting ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white">
          Starting camera...
        </div>
      ) : null}
    </div>
  );
}
