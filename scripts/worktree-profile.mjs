import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const defaultStateRoot = join(homedir(), ".local", "state", "muximo");

export function applyDevWorktreeProfile(env = process.env, cwd = process.cwd()) {
  const profile = resolveDevWorktreeProfile(env, cwd);

  return {
    ...env,
    MUXIMO_WORKTREE_ID: env.MUXIMO_WORKTREE_ID ?? profile.id,
    MUXIMOD_INSTANCE_DIR: env.MUXIMOD_INSTANCE_DIR ?? profile.instanceDirectory,
    MUXIMOD_PORT: env.MUXIMOD_PORT ?? String(profile.muximodPort),
    VITE_DEV_PORT: env.VITE_DEV_PORT ?? String(profile.webPort),
  };
}

export function resolveDevWorktreeProfile(env = process.env, cwd = process.cwd()) {
  const worktreeRoot = gitWorktreeRoot(cwd) ?? realpathSafe(cwd);
  const id = createHash("sha256").update(worktreeRoot).digest("hex").slice(0, 16);
  const stateBase = resolve(env.MUXIMO_DEV_STATE_ROOT ?? defaultStateRoot);
  const stateRoot = join(stateBase, "worktrees", id);
  const seed = Number.parseInt(id.slice(0, 8), 16);

  return {
    id,
    worktreeRoot,
    instanceDirectory: stateRoot,
    muximodPort: 4_318 + (seed % 1_000),
    webPort: 5_320 + (seed % 1_000),
  };
}

function gitWorktreeRoot(cwd) {
  try {
    return realpathSafe(
      execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return undefined;
  }
}

function realpathSafe(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
