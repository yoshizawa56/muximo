import { createInterface } from "node:readline/promises";
import type { AgentSessionRecord } from "@muximo/domain";

export async function confirmCleanup(
  environment: NodeJS.ProcessEnv,
  session: AgentSessionRecord,
  dirty?: boolean,
): Promise<boolean> {
  if (environment.MUXIMO_ASSUME_YES === "1") return true;
  if (!process.stdin.isTTY && !process.stdout.isTTY) return false;
  const prompt =
    dirty === true
      ? `Cleanup session '${session.name}' and remove worktree '${session.worktreePath}' including uncommitted changes? [y/N] `
      : dirty === false
        ? `Cleanup session '${session.name}' and remove worktree '${session.worktreePath}'? [y/N] `
        : `Cleanup session '${session.name}' and remove worktree '${session.worktreePath}' including any uncommitted changes? [y/N] `;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(prompt);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
