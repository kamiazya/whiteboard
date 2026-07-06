# Auth

Authorization bugs fail open by default unless every path is deliberately
fail-closed.

## Criteria

### 1. Fail-closed on ambiguous/error states

Check:
- Does an auth check default to deny when a token, scope, or origin lookup
  errors or returns an ambiguous result, rather than defaulting to allow?

### 2. Scope enforcement matches HTTP method

Check:
- Does a write-capable route (`POST`/`PUT`/`PATCH`/`DELETE`) require a write
  scope (`isWrite` → write scope), not merely "authenticated"?

### 3. Token/error non-leakage

Check:
- Do error responses or logs avoid echoing back tokens, secrets, or
  internal auth-state detail that could aid an attacker?

### 4. Origin exact-match

Check:
- Does origin validation use an exact match (or an explicit allow-list of
  normalized origins) rather than a substring/prefix check that a crafted
  origin could pass?

### 5. New endpoint inherits existing auth middleware

Check:
- Does a newly added route/tool actually sit behind the same auth/scope
  middleware as its siblings, rather than being wired directly to the
  handler and skipping the check?
