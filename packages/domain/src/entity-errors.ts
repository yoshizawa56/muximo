/** Thrown when stored or supplied data fails entity re-validation. */
export class InvalidEntityError extends Error {
  public readonly code = "invalid_entity" as const;

  public constructor(
    public readonly entity: string,
    options?: { cause?: unknown },
  ) {
    super(`${entity} data failed validation`);
    this.name = "InvalidEntityError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
