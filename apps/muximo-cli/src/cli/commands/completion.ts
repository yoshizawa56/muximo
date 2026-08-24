import type { Command } from "commander";
import { generateZshCompletion } from "../completion/zsh.js";
import type { CliCommandContext } from "./types.js";

export function registerCompletionCommand(parent: Command, context: CliCommandContext): Command {
  const completion = parent.command("completion").description("Generate shell completion scripts");
  completion.action(() => context.report(2));

  const zsh = completion.command("zsh").description("Generate a zsh completion script");
  zsh.action(() => {
    context.io.out.write(generateZshCompletion(parent));
    context.report(0);
  });
  return completion;
}
