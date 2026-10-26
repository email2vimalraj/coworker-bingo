export const ERROR_MESSAGES: Record<string, string> = {
  INVALID_INPUT: "Please check what you entered and try again.",
  EMAIL_TAKEN: "This email has already joined this session.",
  SESSION_NOT_FOUND: "We couldn't find that session. Check the code and try again.",
  SESSION_ENDED: "This session has already ended.",
  NOT_LIVE: "The game hasn't started yet. Wait for the host to start it.",
  TIME_UP: "Time's up! The game is over.",
  ALREADY_SUBMITTED: "You've already submitted your board.",
  SELF_SCAN: "That's your own code. Find a coworker to scan instead!",
  COWORKER_NOT_FOUND:
    "We couldn't find that coworker in this session. Check their code or username and try again.",
  USERNAME_AMBIGUOUS:
    "More than one player has that username. Use their code or full email instead.",
  COWORKER_LIMIT:
    "You've already used this coworker the maximum number of times. Find someone else!",
  CELL_TAKEN: "That square is already waiting on a coworker or filled in.",
  NOT_YOURS: "That request isn't yours to answer.",
  INVALID_TOKEN: "Your player session wasn't recognised. Please join again.",
  CLAIM_NOT_FOUND: "That request no longer exists.",
  CLAIM_NOT_PENDING: "That request has already been answered or has timed out.",
  NOT_ADMIN: "Your account is not an admin. Ask an existing admin to add you on the Admins page.",
  PROMPT_COUNT: "A session needs between 24 and 200 prompts.",
  DUPLICATE_PROMPT: "Each prompt must be different. Remove the repeated ones and try again.",
  // ALREADY_PAUSED / NOT_PAUSED must come before PAUSED: codes are matched by substring in order.
  ALREADY_PAUSED: "The game is already paused.",
  NOT_PAUSED: "The game isn't paused.",
  PAUSED: "The host paused the game",
  EMAIL_DOMAIN: "Please use your work email.",
  ALREADY_STARTED: "This session has already started.",
  PLAYER_NOT_FOUND: "That player no longer exists. They may have already been removed.",
  USER_NOT_FOUND:
    "No account with that email yet. They must first create an account at /admin/login.",
  CANNOT_REMOVE_SELF: "You can't remove yourself as an admin.",
  LAST_ADMIN: "You can't remove the last admin.",
  CODE_GENERATION_FAILED: "Couldn't generate a unique code. Please try again.",
};

export const ERROR_CODES = Object.keys(ERROR_MESSAGES);

/** Finds a known error code inside an error message, or returns null. */
export function extractErrorCode(message: string | undefined | null): string | null {
  if (!message) return null;
  for (const code of ERROR_CODES) {
    if (message.includes(code)) return code;
  }
  return null;
}

export class ApiError extends Error {
  code: string | null;
  constructor(message: string) {
    super(message);
    this.code = extractErrorCode(message);
  }
}

/** Friendly text for any thrown value. */
export function friendlyError(e: unknown): string {
  const message =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e ?? "");
  const code = e instanceof ApiError ? e.code : extractErrorCode(message);
  if (code) return ERROR_MESSAGES[code];
  if (/failed to fetch|network|load failed/i.test(message)) {
    return "Can't reach the server. Check your connection and try again.";
  }
  return "Something went wrong. Please try again.";
}

export function errorCodeOf(e: unknown): string | null {
  if (e instanceof ApiError) return e.code;
  return extractErrorCode(e instanceof Error ? e.message : null);
}
