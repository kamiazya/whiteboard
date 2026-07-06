# Maintainability

Size, duplication, dead code, misleading comments, and mutation where
immutability is the rule.

## Criteria

### 1. Oversized files

Check:
- Any source file over ~800 lines (AGENTS.md's ceiling)? Over ~400 lines
  without a clear single responsibility?
- Would splitting it by feature/domain reduce coupling, or is the length
  justified (e.g. a generated file, a large fixture)?

### 2. Deep nesting

Check:
- Any function with more than ~4 levels of nested conditionals/loops that
  could be flattened with early returns or guard clauses?

### 3. Duplication

Check:
- Grep for near-identical blocks of logic copy-pasted across files instead
  of extracted into a shared utility.
- Is the duplication real (same behavior, same reason to change) or
  coincidental (looks similar, changes independently)?

### 4. Dead code

Check:
- Exported symbols with no importers anywhere in the repo.
- Commented-out code blocks left in place "just in case."

### 5. Comments that lie

Check:
- Does a comment describe behavior the code no longer has (stale after a
  refactor)?
- Does a comment reference a removed feature, an old function name, or a
  since-fixed bug as if it still applies?

### 6. Mutation where immutability is the rule

Check:
- Grep for in-place mutation of function parameters, `.push`/`.splice`/direct
  property assignment on objects that should be treated as immutable per
  AGENTS.md.
