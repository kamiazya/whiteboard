# Dead code

Stale references and orphaned symbols accumulate silently — nothing fails
until a reader trusts them.

## Criteria

### 1. Stale references to dropped features

Check:
- Does this diff leave behind a comment, doc line, or conditional branch
  that refers to a feature, flag, or code path removed in the same change
  (or a prior one this diff builds on)?

### 2. Unused exported symbols

Check:
- Does this diff export a function/type/constant with no remaining internal
  or external caller?
- Conversely, does it remove the last caller of an exported symbol without
  removing the symbol itself?

### 3. Old comments referencing removed code

Check:
- Do comments near the diff describe behavior that no longer matches the
  code below them (e.g. "falls back to X" when X was deleted)?

### 4. Commented-out or debug-only code

Check:
- Does the diff leave commented-out code blocks, `console.*` debug calls, or
  temporary instrumentation that should have been removed before landing?
