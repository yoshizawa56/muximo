import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ignore from "ignore";

export const worktreeIncludeFileName = ".worktreeinclude";

export type WorktreeIncludeMatcher = {
  pathspecs: readonly string[];
  matches(relativePath: string, ignoredDirectories?: readonly string[]): boolean;
};

/** Reads the repository-local worktree include rules using Gitignore semantics. */
export function readWorktreeInclude(workspaceRoot: string): WorktreeIncludeMatcher | undefined {
  const path = join(workspaceRoot, worktreeIncludeFileName);
  if (!existsSync(path)) return undefined;

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`could not read ${worktreeIncludeFileName}: ${path}`, { cause: error });
  }

  const matcher = ignore();
  try {
    matcher.add(contents);
  } catch (error) {
    throw new Error(`invalid ${worktreeIncludeFileName}: ${path}`, { cause: error });
  }
  const pathspecs = gitPathspecs(contents);
  return {
    pathspecs,
    matches: (relativePath, ignoredDirectories = []) => {
      const result = matcher.test(relativePath);
      if (!result.ignored) return false;

      const pattern = result.rule?.pattern;
      if (!pattern?.startsWith("**/")) return true;
      // Claude Code does not descend through a wholly ignored directory for
      // an unrestricted leading **/ pattern unless the directory is named.
      const firstName = pattern.slice(3).split("/", 1)[0];
      return ignoredDirectories
        .filter((directory) => relativePath.startsWith(`${directory}/`))
        .every((directory) => matcher.ignores(directory) || directory.split("/").includes(firstName));
    },
  };
}

/** Returns a conservative Git pathspec superset; the ignore matcher remains authoritative. */
function gitPathspecs(contents: string): readonly string[] {
  const pathspecs = new Set<string>();
  for (const line of contents.split(/\r?\n/u)) {
    const parsed = parsePositivePattern(line);
    if (parsed.kind === "ignore") continue;
    if (parsed.kind === "all") return [":(glob)**"];
    const pattern = parsed.pattern;
    if (pattern === "*" || pattern === "**" || pattern === "**/*") return [":(glob)**"];

    const rootAnchored = pattern.startsWith("/");
    const normalized = pattern.replace(/^\/+|\/+$/gu, "");
    if (!normalized) return [":(glob)**"];

    const base = rootAnchored || normalized.includes("/") ? normalized : `**/${normalized}`;
    pathspecs.add(`:(glob)${normalized}`);
    if (!rootAnchored) pathspecs.add(`:(glob)${base}`);
    pathspecs.add(`:(glob)${base}/**`);
    if (!rootAnchored && !normalized.includes("/")) pathspecs.add(`:(glob)${normalized}/**`);
  }
  return [...pathspecs];
}

type ParsedPattern = { kind: "ignore" } | { kind: "all" } | { kind: "pattern"; pattern: string };

function parsePositivePattern(line: string): ParsedPattern {
  if (!line || line.startsWith("#")) return { kind: "ignore" };
  if (line.startsWith("!")) return { kind: "ignore" };
  if (/\s/u.test(line) || line.includes("\\") || line.includes("[") || line.includes("]")) {
    return { kind: "all" };
  }
  return { kind: "pattern", pattern: line };
}
