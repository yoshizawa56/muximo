/** Control-channel failures carry a stable machine-readable code. */
export class ControlFailure extends Error {
  public readonly _tag = "ControlFailure" as const;

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlFailure";
  }
}

export function controlFailure(code: string, message: string): ControlFailure {
  return new ControlFailure(code, message);
}
