import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ignore from "ignore";

export const worktreeIncludeFileName = ".worktreeinclude";

export type WorktreeIncludeMatcher = {
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
  return {
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
