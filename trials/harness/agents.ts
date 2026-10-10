import { claudePreflight, claudeTurn, forgetClaudeProject } from "./claude.ts";
import { codexPreflight, codexTurn, forgetCodexThreads } from "./codex.ts";
import { agentTurn, cursorEnv, preflight, type TurnRequest, type TurnResponse } from "./cursor.ts";

/** The coding agents a trial can run. */
export type AgentName = "cursor" | "codex" | "claude";

export interface AgentAdapter {
  readonly name: AgentName;
  readonly label: string;
  /** The CLI's version, after checking that it is installed and logged in. */
  readonly preflight: () => Promise<string>;
  readonly turn: (request: TurnRequest) => Promise<TurnResponse>;
  /** Drop what the agent stored about a shop the harness throws away. */
  readonly forget: (workspace: string) => Promise<void>;
}

export const AGENTS: Readonly<Record<AgentName, AgentAdapter>> = {
  cursor: {
    name: "cursor",
    label: "Cursor",
    preflight: () => preflight(),
    turn: agentTurn,
    forget: async () => undefined,
  },
  codex: {
    name: "codex",
    label: "Codex",
    preflight: () => codexPreflight(cursorEnv()),
    turn: codexTurn,
    forget: forgetCodexThreads,
  },
  claude: {
    name: "claude",
    label: "Claude Code",
    preflight: () => claudePreflight(cursorEnv()),
    turn: claudeTurn,
    forget: forgetClaudeProject,
  },
};

/** An agent and the model it runs. `undefined` is the CLI's own default. */
export interface AgentChoice {
  readonly agent: AgentAdapter;
  readonly model?: string;
}

/** Each agent's model when `--model` is not given. */
export const DEFAULT_MODEL: Readonly<Partial<Record<AgentName, string>>> = {
  cursor: "grok-4.7-medium-fast",
};

/**
 * `--agent cursor` runs every trial with Cursor; `--agent cursor,codex` (and
 * the default, `random`) picks one of them at random for each trial, so a
 * sweep spreads across agents. `--model` applies only to a single agent.
 */
export function agentPool(spec: string, model?: string): AgentChoice[] {
  const names =
    spec === "random" ? ["cursor", "codex"] : spec.split(",").map((name) => name.trim());
  if (model !== undefined && names.length > 1) {
    throw new Error("--model names one agent's model; pass it with a single --agent.");
  }
  return names.map((name) => {
    const agent = AGENTS[name as AgentName];
    if (agent === undefined) {
      throw new Error(
        `Unknown agent "${name}". Available: ${Object.keys(AGENTS).join(", ")}, random`,
      );
    }
    return { agent, model: model ?? DEFAULT_MODEL[agent.name] };
  });
}

export function pick(
  pool: readonly AgentChoice[],
  random: () => number = Math.random,
): AgentChoice {
  const choice = pool[Math.floor(random() * pool.length)] ?? pool[0];
  if (choice === undefined) throw new Error("No agent to run.");
  return choice;
}
