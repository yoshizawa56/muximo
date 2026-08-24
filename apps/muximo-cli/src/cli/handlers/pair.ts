import type { CliHandlers, CliPairInput } from "../commands/types.js";

export type PairHandlerDependencies = {
  execute(input: { controlSocket: string; muximodBaseUrl: string; display: CliPairInput["display"] }): Promise<number>;
  resolveControlSocket(input: CliPairInput): string;
  resolveMuximodBaseUrl(input: Pick<CliPairInput, "withoutServe">): Promise<string>;
};

export function createPairHandler(dependencies: PairHandlerDependencies): CliHandlers["pair"] {
  return async (input) =>
    dependencies.execute({
      controlSocket: dependencies.resolveControlSocket(input),
      muximodBaseUrl: input.muximodBaseUrl ?? (await dependencies.resolveMuximodBaseUrl(input)),
      display: input.display,
    });
}
