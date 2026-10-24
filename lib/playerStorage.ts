export interface StoredPlayer {
  token: string;
  playerId: string;
  playerCode: string;
}

const key = (sessionCode: string) => `coworker-bingo:player:${sessionCode.toUpperCase()}`;

export function loadPlayer(sessionCode: string): StoredPlayer | null {
  try {
    const raw = window.localStorage.getItem(key(sessionCode));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredPlayer>;
    if (typeof v.token === "string" && v.token) {
      return { token: v.token, playerId: v.playerId ?? "", playerCode: v.playerCode ?? "" };
    }
  } catch {
    // storage unavailable or corrupt
  }
  return null;
}

export function savePlayer(sessionCode: string, player: StoredPlayer): void {
  try {
    window.localStorage.setItem(key(sessionCode), JSON.stringify(player));
  } catch {
    // ignore (private mode etc.)
  }
}

export function clearPlayer(sessionCode: string): void {
  try {
    window.localStorage.removeItem(key(sessionCode));
  } catch {
    // ignore
  }
}
