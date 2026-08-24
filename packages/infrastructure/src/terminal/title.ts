import type { Writable } from "node:stream";

export interface TerminalTitlePort {
  set(title: string): void;
  restore(): void;
}

/** Emits terminal-title control sequences without exposing a stream to agent providers. */
export class OscTerminalTitleAdapter implements TerminalTitlePort {
  public constructor(
    private readonly output: Pick<Writable, "write"> & { isTTY?: boolean },
    private readonly enabled: boolean,
  ) {}

  public set(title: string): void {
    if (!this.enabled || !this.output.isTTY) return;
    this.output.write(`\u001b]0;${title}\u0007`);
  }

  public restore(): void {
    if (!this.enabled || !this.output.isTTY) return;
    this.output.write("\u001b]0;\u0007");
  }
}
