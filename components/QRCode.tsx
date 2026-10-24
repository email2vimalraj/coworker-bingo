"use client";
import { useEffect, useState } from "react";
import QR from "qrcode";

/** Renders `value` as a QR code image (data URL generated with the `qrcode` package). */
export function QRCode({
  value,
  size = 256,
  className = "",
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QR.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: Math.max(256, size * 2),
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  return (
    <div
      className={`inline-block rounded-2xl bg-white p-1 ${className}`}
      style={{ width: size, height: size, maxWidth: "100%" }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="QR code" width={size} height={size} className="h-full w-full" />
      ) : (
        <div className="h-full w-full animate-pulse rounded-xl bg-slate-100" />
      )}
    </div>
  );
}
