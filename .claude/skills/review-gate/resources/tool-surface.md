# Tool Surface

Opt-in: pass it in `dimensions` for a diff that touches an MCP tool's name,
description, input schema, annotations or existence — anything under
`packages/server-core/src/tools/**` or `packages/mcp-server/src/server/mcp/**`
that a model reads. `notApplicable` otherwise.

A tool definition is in the model's context on every turn. ADR-0031 fixes
the criteria (C1–C14) and two scoreboards pin what they measure; this
dimension asks whether the diff moved them honestly and whether what it
says to a model is true of what it does. The `mcp-tool-surface` skill is
the procedure the author should have followed.

## Criteria

### 1. The scoreboards moved for a stated reason

Check:
- Does the diff re-pin rows in `tool-surface-quality.test.ts` or
  `tool-call-count-quality.test.ts`? Every re-pinned row carries, in a
  comment or the commit, WHY it moved and in which currency (bytes a model
  no longer reads, calls an errand no longer makes, parameters described).
  A row re-pinned with no reason is a finding.
- For a rename, consolidation or retirement: does the PR body carry the
  rung-3 lane's before AND after (`pnpm eval:tool-surface --trials=3`)?
  One reading is not evidence; a missing "after" is a finding.
- Did C1 (visible bytes) or C13 (calls) or C3 (undescribed) move DOWN, and
  did C14 (pass^k) not fall? A change that only reduced the tool count is
  a finding: it changed the table's shape and nothing a model pays for.

### 2. The description is true, and says when

Check:
- Does the description say what the tool does in the caller's terms, and
  when to reach for it over its neighbours? "Set facets on a document"
  for the tool that sets tags is the shape of the failure (three trials of
  "tag this note" reached it once).
- Does every parameter added or reshaped carry `.describe()`? C3 counts
  down, never up; a new undescribed parameter is a finding.
- Does the description name a tool that no longer exists, or quote a
  rung-3 task? Both are findings (`mcp-guidance-tool-names.test.ts` and
  `skills-tool-surface.test.ts` catch some of this; the description text
  they do not).

### 3. Annotations and errors tell the truth

Check:
- Is the `TOOL_PROFILES` entry annotated for the tool's WORST op? A tool
  that can delete and is not `destructiveHint` is a finding; a tool that
  cannot be given one honest value is two tools (C6).
- Is the Zod object registered rather than its `.shape`, so a stray key is
  refused by name (C10)? A new tool that strips is a finding; an existing
  one is the debt ADR-0031 §6 files, not this diff's.
- Does every refusal the diff adds or changes name the right parameter on
  the right tool, in `vocabulary.md`'s words (C11)? A message that sends
  the caller to another tool's parameter is a finding.

### 4. Nothing was consolidated across a risk boundary

Check:
- Does a consolidation put a read-only path and a destructive path behind
  one name? That is a finding however many tools it saved (C6).
- Does a consolidation remove the only way to say something — the way
  retiring `wb_document_create` would have removed `actor` until the batch
  carried it? Enumerate what the retired tool's schema could express that
  the survivor's cannot.
