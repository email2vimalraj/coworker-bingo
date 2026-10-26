"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { playerApi } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { clearPlayer, loadPlayer } from "@/lib/playerStorage";
import { usePlayerPoll } from "@/lib/usePlayerPoll";
import { useAlerts } from "@/lib/useAlerts";
import { normalizeSessionCode } from "@/lib/codes";
import type { PollResponse } from "@/lib/supabase/types";
import { useRequestPopups } from "@/lib/requestPrefs";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Spinner } from "@/components/ui";

interface PlayerContextValue {
  sessionCode: string;
  token: string;
  data: PollResponse;
  offset: number;
  refresh: () => Promise<void>;
  /** Answer an incoming confirmation request, then refresh. */
  respond: (claimId: string, accept: boolean) => Promise<void>;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);
const BoostContext = createContext<((delta: number) => void) | null>(null);

/** While the calling component is mounted, poll every 1s (used by the player's own QR). */
export function usePollBoost(): void {
  const change = useContext(BoostContext);
  useEffect(() => {
    if (!change) return;
    change(1);
    return () => change(-1);
  }, [change]);
}

export function usePlayer(): PlayerContextValue {
  const v = useContext(PlayerContext);
  if (!v) throw new Error("usePlayer must be used inside PlayerProvider");
  return v;
}

/** Wraps every /play/[code]/* page: token lookup, polling, and the incoming-confirmation sheet. */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const [popups] = useRequestPopups();
  const sessionCode =
    normalizeSessionCode(params.code ?? "") ??
    (params.code ?? "").toUpperCase();
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [boosters, setBoosters] = useState(0);
  const changeBoost = useCallback(
    (delta: number) => setBoosters((n) => n + delta),
    [],
  );
  const { data, errorCode, failed, offset, refresh } = usePlayerPoll(
    token,
    boosters > 0,
  );

  useAlerts(data ?? null);

  useEffect(() => {
    const stored = loadPlayer(sessionCode);
    if (!stored) {
      router.replace(`/join/${sessionCode}`);
      return;
    }
    setToken(stored.token);
    setChecked(true);
  }, [sessionCode, router]);

  useEffect(() => {
    if (errorCode === "INVALID_TOKEN") {
      clearPlayer(sessionCode);
      router.replace(`/join/${sessionCode}`);
    }
  }, [errorCode, sessionCode, router]);

  const respond = useCallback(
    async (claimId: string, accept: boolean) => {
      if (!token) return;
      await playerApi.respondClaim(token, claimId, accept);
      await refresh();
    },
    [token, refresh],
  );

  if (!checked || !token || !data) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-4">
        {failed && errorCode !== "INVALID_TOKEN" ? (
          <p className="text-center text-slate-600">
            {errorCode
              ? friendlyError(new Error(errorCode))
              : "Can't reach the server. Retrying..."}
          </p>
        ) : (
          <Spinner />
        )}
      </main>
    );
  }

  return (
    <BoostContext.Provider value={changeBoost}>
      <PlayerContext.Provider
        value={{ sessionCode, token, data, offset, refresh, respond }}
      >
        {failed ? (
          <div className="bg-amber-100 px-3 py-1 text-center text-sm font-medium text-amber-900">
            Connection problem, retrying...
          </div>
        ) : null}
        {children}
        {popups && !pathname?.endsWith("/requests") ? (
          <ConfirmSheet incoming={data.incoming} onRespond={respond} />
        ) : null}
      </PlayerContext.Provider>
    </BoostContext.Provider>
  );
}
