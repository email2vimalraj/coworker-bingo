"use client";
import { useEffect, useState } from "react";
import { getAppOrigin } from "@/lib/appUrl";
import { playerQrUrl } from "@/lib/codes";
import { QRCode } from "@/components/QRCode";
import { CopyButton } from "@/components/CopyButton";
import { usePollBoost } from "@/components/PlayerProvider";

/** The player's own QR + text code + copy button. */
export function MyQr({
  sessionCode,
  playerCode,
  size = 240,
  big = false,
}: {
  sessionCode: string;
  playerCode: string;
  size?: number;
  big?: boolean;
}) {
  usePollBoost(); // someone is probably scanning me: check for their request every 1s
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(getAppOrigin()), []);
  return (
    <div className="flex flex-col items-center gap-3">
      {origin ? (
        <QRCode value={playerQrUrl(origin, sessionCode, playerCode)} size={size} className="border border-slate-200" />
      ) : (
        <div style={{ width: size, height: size }} className="rounded-2xl bg-slate-100" />
      )}
      <p className="text-sm font-semibold text-slate-500">Or share this code</p>
      <p className={`font-mono font-extrabold tracking-widest text-slate-900 ${big ? "text-5xl" : "text-3xl"}`}>
        {playerCode}
      </p>
      <CopyButton text={playerCode} label="Copy code" />
    </div>
  );
}
