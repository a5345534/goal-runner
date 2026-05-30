export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

export type GoalCommand =
  | { kind: "show" }
  | { kind: "start"; objective: string; tokenBudget?: number }
  | { kind: "edit"; objective?: string; tokenBudget?: number }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" };

export function validateGoalObjective(input: string): string {
  const objective = input.trim();
  if (!objective) {
    throw new Error("goal objective must not be empty");
  }
  const length = Array.from(objective).length;
  if (length > MAX_GOAL_OBJECTIVE_CHARS) {
    throw new Error(`goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters`);
  }
  return objective;
}

export function parseTokenBudget(input: string): number {
  const raw = input.trim();
  const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(raw);
  if (!match) {
    throw new Error(`invalid token budget: ${input}`);
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`invalid token budget: ${input}`);
  }

  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const budget = Math.floor(amount * multiplier);
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error(`invalid token budget: ${input}`);
  }
  return budget;
}

export function parseGoalCommand(args = ""): GoalCommand {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "show" };

  const tokens = tokenize(trimmed);
  const [first, ...rest] = tokens;

  switch (first) {
    case "edit": {
      if (rest.length === 0) return { kind: "edit" };
      const parsed = parseBudgetAndObjective(rest, "edit");
      return { kind: "edit", ...parsed };
    }
    case "pause":
      ensureNoExtraArgs(first, rest);
      return { kind: "pause" };
    case "resume":
      ensureNoExtraArgs(first, rest);
      return { kind: "resume" };
    case "clear":
      ensureNoExtraArgs(first, rest);
      return { kind: "clear" };
    default: {
      const parsed = parseBudgetAndObjective(tokens, "start");
      return { kind: "start", objective: parsed.objective, tokenBudget: parsed.tokenBudget };
    }
  }
}

function parseBudgetAndObjective(tokens: string[], command: "start" | "edit"): { objective: string; tokenBudget?: number } {
  const remaining = [...tokens];
  let tokenBudget: number | undefined;

  if (remaining[0] === "--tokens") {
    const rawBudget = remaining[1];
    if (!rawBudget) {
      throw new Error("missing token budget after --tokens");
    }
    tokenBudget = parseTokenBudget(rawBudget);
    remaining.splice(0, 2);
  }

  if (remaining.length === 0) {
    throw new Error(command === "edit" ? "goal edit objective must not be empty" : "goal objective must not be empty");
  }

  return { objective: validateGoalObjective(remaining.join(" ")), tokenBudget };
}

function ensureNoExtraArgs(command: string, rest: string[]): void {
  if (rest.length > 0) {
    throw new Error(`/goal ${command} does not accept extra arguments`);
  }
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error("unterminated quote in /goal command");
  }
  if (current) tokens.push(current);
  return tokens;
}
