# Wiring gaps

Features that build/typecheck but do not actually function — the "looks done, isn't"
class (e.g. the Cloudflare shell that rendered but had no working canvas).

## Criteria

### 1. Placeholder or stub renders

Check:
- Grep for `data-testid` elements or components whose implementation is a bare
  `<div>`/placeholder rather than the real feature.
- Does a UI surface claim a capability (button, route, tab) that renders nothing
  functional behind it?

### 2. Load-bearing but underscore-prefixed values

Check:
- Grep for `_`-prefixed variables/params that are actually read/used downstream
  (the underscore usually signals "intentionally unused" — if it's load-bearing,
  that's a wiring smell).

### 3. TODO / FIXME / not-implemented markers on critical paths

Check:
- Grep for `TODO`, `FIXME`, `not implemented`, `NotImplementedError` in
  non-test source.
- Does the marker sit on a path a real user flow depends on (not a documented
  future enhancement)?

### 4. UI with no backend, or backend with no caller

Check:
- For a new UI action (button, form submit), does it call a real
  route/tool/handler, or is the handler missing/mocked?
- For a new route/tool, is it actually invoked from any client code, MCP tool
  registration, or test — or is it dead weight nobody calls?

### 5. Dead routes

Check:
- Do all registered routes/tools have at least one caller (UI, test, or
  documented external consumer)?
- Grep route/tool registration files against actual call sites.
