/** Plain-language rules for players, generated from the session's actual settings. Pure: no imports from the app. */
export interface RulesInput {
  duration_seconds: number;
  max_squares_per_coworker: number;
  winners_count: number;
  ranking_mode: "correct_then_time" | "full_card_fastest" | "lines";
  lines_to_win: number;
  require_full_card: boolean;
  allow_username_claims: boolean;
}

export interface RulesSection {
  heading: string;
  items: string[];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function durationText(seconds: number): string {
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function buildRules(s: RulesInput): RulesSection[] {
  const fill = [
    "Tap a square to see its prompt, then find a coworker it is true for.",
    s.allow_username_claims
      ? "Scan their QR code, or type their code or username (the part of their email before the @)."
      : "Scan their QR code, or type their code (like QX7-4PM).",
    "Your coworker gets a request on their phone and confirms it with Yes or No. Only confirmed squares count.",
    "If they say No or don't answer in 2 minutes, the square reopens and you can try someone else.",
    "You can cancel a waiting request to free the square.",
  ];

  const answer = [
    "When a coworker asks you to confirm a square, a pop-up appears (unless you turned pop-ups off). Tap Yes if the prompt is true for you, otherwise No.",
    "Tap the Requests button to see everyone waiting on you and answer them without interrupting your own game. The badge shows how many are waiting.",
    "Answering requests quickly helps everyone, and it keeps working after you submit your own board.",
  ];

  const limits = [
    `You can use the same coworker for up to ${plural(s.max_squares_per_coworker, "square")}.`,
    `The game lasts ${durationText(s.duration_seconds)}. When time is up, your board is locked.`,
    "The host can pause the game briefly. The timer stops and boards are locked until it resumes.",
  ];

  const win: string[] = [];
  if (s.ranking_mode === "lines") {
    win.push(
      `A line is a row, column or diagonal. The FREE centre counts. Complete ${plural(s.lines_to_win, "line")} to win.`,
      "The first players to reach that many lines win. If you tie, the one who got there sooner ranks higher.",
    );
  } else if (s.ranking_mode === "full_card_fastest") {
    win.push(
      "Only players who complete all 24 squares are ranked. The fastest full card wins.",
    );
  } else {
    win.push("The player with the most confirmed squares wins. If players tie, whoever submitted sooner ranks higher.");
    if (s.require_full_card) win.push("Only full cards (all 24 squares) can win a prize.");
  }
  win.push(`There ${s.winners_count === 1 ? "is" : "are"} ${plural(s.winners_count, "winner")}. You need at least one confirmed square to win.`);
  if (s.ranking_mode !== "lines") {
    win.push("Done early? Submit your board. Your time is when you submit, so submitting early helps break ties. You can't change the board afterwards.");
  } else {
    win.push("You can submit your board early if you are done. You can't change it afterwards.");
  }

  return [
    { heading: "Fill a square", items: fill },
    { heading: "Answer requests", items: answer },
    { heading: "Limits", items: limits },
    { heading: "How winning works", items: win },
  ];
}
