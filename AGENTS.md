# Repository Instructions

## Language policy

- Write all source code, comments, identifiers, user-facing strings, configuration, documentation, tests, fixtures, examples, commit messages, pull request titles and descriptions, and generated artifacts in English.
- Do not add Japanese or other non-English text unless the task explicitly requests localized content or the text belongs to an intentional localization resource.
- When modifying existing non-English text, translate it to English unless preserving it is required by the task or by an external protocol.
- Keep error messages, logs, accessibility labels, permission descriptions, and test data in English as well.

## Alpha compatibility policy

- Muximo is currently alpha software. Do not preserve backward compatibility, legacy aliases, compatibility shims, or fallback paths solely for existing clients, data, configuration, or internal implementations.
- Keep only the current implementation and its current contract. When an interface or data shape improves, remove the old shape and update all in-repository callers, tests, fixtures, examples, and documentation in the same change.
- Prefer a clear failure for unsupported old input over silently accepting, translating, or storing it.
- Add future compatibility deliberately through an explicit versioned contract or migration with tests; never make the current implementation accept old shapes implicitly.
- Keep schema migration history and add explicit forward migrations when existing data must be moved to the current schema; those migrations must not become compatibility aliases or silent fallback paths.
