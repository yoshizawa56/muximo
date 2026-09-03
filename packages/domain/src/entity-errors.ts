/** Thrown when stored or supplied data fails entity re-validation. */
export class InvalidEntityError extends Error {
  public readonly _tag = "InvalidEntityError" as const;
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

/**
 * Thrown when an update attempts to change an immutable entity field.
 * Carries no wire code so boundary mapping stays identical to the previous
 * uncoded Error; the tag and fields serve internal narrowing and logs.
 */
export class ImmutableEntityFieldError extends Error {
  public readonly _tag = "ImmutableEntityFieldError" as const;

  public constructor(
    public readonly entity: string,
    public readonly field: string,
  ) {
    super(`${entity} update cannot change immutable field: ${field}`);
    this.name = "ImmutableEntityFieldError";
  }
}
