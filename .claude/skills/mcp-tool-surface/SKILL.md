---
name: mcp-tool-surface
description: How to change the whiteboard MCP tool table — rename, re-describe, reshape, add, consolidate or retire a tool — with the two scoreboards and the LLM-driven lane that ADR-0030 makes the evidence. Use before touching a tool's name, description, input schema, annotations or existence under packages/server-core/src/tools/** or packages/mcp-server/src/server/mcp/**, when a consolidation is proposed, when someone says "too many tools", or when adding an eval task. Not for the daemon's HTTP routes or the web app.
---

# The tool surface is judged by an instrument

A tool definition is read by a model on every turn of every conversation
that has this server attached, and a model asked to do something reads the
table before it reads the document. So a change to the table is not judged
by whether the tests pass — they pass either way — but by four numbers
nobody sees in the diff: what the table costs to read, how much of it
explains itself, what an errand costs in calls, and whether a real model
still completes the errands. The criteria are
[ADR-0030](../../../docs/contributing/adr/0030-tool-surface-criteria.md)
§1 (C1–C14, each tagged with the rung that checks it); this skill is the
procedure.

The count is not a criterion. The last consolidation would have steered
by it, and the count cannot see the two largest debts the instrument found
on its first run: one tool being 45% of everything the model reads, and
299 of 324 parameters undescribed.

## The ladder, and which rung a change runs

| rung | what | command | runs |
|---|---|---|---|
| 1 | tool-surface scoreboard: per tool, model-visible bytes, wire bytes, description words, parameters and how many are undescribed, what a stray key gets, which neighbours the description names; plus totals, and C9 for every tool | `pnpm test --project mcp-node packages/mcp-server/src/server/mcp/tool-surface-quality.test.ts` | every push; pinned exactly |
| 2 | errand scoreboard: calls and bytes per errand | `pnpm test --project mcp-node packages/mcp-server/src/server/mcp/tool-call-count-quality.test.ts` | every push; pinned exactly |
| 3 | LLM-driven lane: a real model, only this server's tools, a seeded fixture, graded by outcome | `pnpm eval:tool-surface` (`--trials=3`, `--only=<substring>`, `--model=<alias>`, `--out=<file>`, `--dry-run`) | on demand; spends quota (~$0.06 a task, ~$0.70 a run); skips without the `claude` CLI |

| the change | rungs |
|---|---|
| a description or a `.describe()` on a parameter | 1, then 3 for the tasks that touch the tool — the one study that measured it found description fixes regress a sixth of cases, so a rewrite is not assumed to help |
| an input schema reshaped | 1, 2 |
| a tool added | 1, 2 (write its errand), 3 (write its task), plus the four-place list `mcp-smoke-coverage.ts` documents and a `smoke:e2e` call |
| a rename, a consolidation, a retirement | 1, 2, and 3 with `--trials=3` BEFORE and AFTER, both readings in the PR |
| a change to the server `instructions` | 3 |

## Procedure for a rename, consolidation or retirement

1. **Take the before reading.** On the base commit: rung 1 and 2 are the
   pinned values already in the tests; rung 3 is
   `pnpm eval:tool-surface --trials=3 --out=tmp/notes/tool-surface-before.json`.
   Three trials, because one is a reading and the pass column moves
   between trials on a tool that is reachable but not reliably reached
   (the tag-write task took three different routes in three trials).
2. **Make the change.** Rung 1 and 2 go red — that is the design. Re-pin
   each moved row, and write beside it WHY it moved, in the currency it
   moved in: bytes the model no longer reads, calls an errand no longer
   makes, parameters that now say what they are for. A row re-pinned with
   no reason is the regression the exact pin exists to refuse.
3. **Take the after reading** with the same command and trials.
4. **Decide by the columns, in this order.** C14 (rung-3 pass^k) may not
   fall. Then at least one of C1 (visible bytes), C13 (calls) or C3
   (undescribed) must have moved down, and the PR says which and by how
   much. A change that cut the count and moved none of those has changed
   the table's shape and nothing a model pays for.
5. **Read the calls column as a diagnostic, never as the gate.** A task
   that passes in seven calls where the errand scoreboard's cheapest path
   is two has not failed; it says C4 or C5 is unmet on the tools it
   wandered through, and the `tools` column says which. Grading by the
   path an author expected is what the sources call brittle, and the
   lane deliberately does not do it.
6. **Put both readings in the PR body**, the way `visual-evidence` puts
   two panels: the rung-1 totals before and after, the rung-2 rows that
   moved, and the rung-3 summary (pass^k, mean calls, cost) before and
   after. Retirements are breaking for MCP clients under the 0.0.x
   no-compat policy; say so in the title (`feat(mcp)!:`) and update the
   product skills under `./skills/*` — `skills-tool-surface.test.ts`
   catches a skill still naming a retired tool.

## In the development flow

- **Inline (the default for a surface change):** load this skill, take the
  before reading, change, re-pin, take the after reading, then run
  `review.workflow.mjs` over the diff with `dimensions` including
  `{ name: 'tool-surface', content: <resources/tool-surface.md> }` beside
  the defaults — the criteria file is
  `.claude/skills/review-gate/resources/tool-surface.md`, and the
  `review-gate` skill says how a caller globs and passes it.
- **Through `dev-loop`:** its design prompt asks for the rows the change
  will move and, for a rename or retirement, the lane's before/after in
  `testScenarios`; pass `reviewArgs: { dimensions: [...] }` so the
  composed review carries the dimension. The `developer` agent has no
  `claude` CLI and no quota, so the rung-3 readings are the main
  session's: take them before launching and after folding.
- **In the PR:** both readings, the way `visual-evidence` ships two
  panels. A reviewer reads C14 first, then which of C1/C13/C3 moved.

## Reading a rung-3 result

The lane prints one line per task and a summary; `--out` keeps the runs
with every tool call, tool-error text, token and cost figure.

- **A failure is probed against the store, not read off the transcript.**
  Two of the baseline's failures looked like model mistakes and were the
  product's: a tag-filtered search that cannot stand alone, and a comment
  thread that does not survive a restart. Reproduce what the model saw
  with `connectWhiteboard` from `scripts/eval/lib/whiteboard-client.mjs`
  against a seeded directory before concluding anything about the model.
- **`toolErrorTexts` is the C11 evidence, and sometimes the C5 evidence.**
  It is what the model was told when a call was refused. A refusal that
  names the wrong tool's parameter (`wb_document_list` telling the caller
  to pass `createWorkspace`) is a finding on the message and the fix is
  cheap; a refusal that says the tool cannot take what the task needs
  (`facets.tags` must match `{namespace}.{name}/v{n}`) is a gap in the
  surface, and the fix is a parameter.
- **An errand that keeps counting past a refusal is a scoreboard that
  lies.** The errand corpus's `call` throws on `isError` for this reason:
  two of its four rows had measured a refused write and a crashed seam
  as one cheap call each. A harness that drives real tools supplies every
  seam the tools reach (`InMemoryVersionHistory`), or the tool answers an
  error and the count reads as success.
- **`tools` says what the surface failed to offer — read the refusal
  texts before blaming the description.** Three trials of "tag this note"
  wandered through four tools, and the first reading was "the description
  never says tags". The refusal text said the tool could not take a tag at
  all: an errand step with no tool behind it (C5), which no description
  fixes. When a task wanders, read what each refusal told the model, then
  the description of the tool it should have reached, in that order.
- **A batch tool's line names the ARM the model picked.** `tools` prints
  `wb_canvas_edit[region.set]` or `wb_canvas_edit[node.add]`, because the
  tool name alone cannot say whether a declarative op was reached or the
  model got the same outcome with the imperative one — and that is the
  whole question a change to one arm's shape is judged on. The `--out`
  JSON keeps each call's `inputs` beside it, so whether the model declared
  geometry or left it to placement can be read rather than guessed.
- **A call AFTER the write is the lane grading the write's result.** The
  group-contents task passed every trial, and after a description got the
  model to leave geometry to placement, every trial then spent one more
  `node.patch` moving the placed box — placement had been putting it on
  top of what the group already held, since the op shipped. Read
  `inputs` for what the extra call undid; a pass with a repair call in it
  is a product finding, not a model one.
- **A description is a promise the refusal text has to keep.** `within`
  said "the group grows to fit"; a node given `within` and a position past
  the edge was still refused, and the lane hit that refusal three trials
  of three — the model had done what the description said it could. When
  a parameter's description names a behaviour, grep the refusals on that
  path for the case the description covers.
- **Look at the boards, not only the verdicts.** A write task that
  declares `boards: ['boards/x']` gets each named board rendered through
  `wb_scene_render` into `<out>-boards/` beside `--out`; rasterise with
  resvg from `packages/mcp-server` (it owns the binding) and read the
  PNGs. The first look found two rendering bugs — a cropped group label
  and a coloured group painted over its members — on drawings the grader
  had passed, because the grader reads the store and a person reads the
  picture. A layout task without its picture has been half-graded.
- **Every read costs ~69k input tokens even at two calls.** The table is
  ~8.7k of that; the rest is the CLI's own system prompt. That is why the
  lane reports cost beside tokens, and why a change is judged on C1
  rather than on the lane's token column.
- **pass^k, not pass@1, is the reliability number.** A task that passes
  one trial in three is answerable and not reliably answered — the case
  the pair exists to separate.

## Adding a task to the lane

`scripts/eval/tasks.mjs`, following the rules in its header, which are
Anthropic's mcp-builder rules:

- **Read tasks** carry a single stable `answer` compared as a string.
  Phrase the question so it does not carry the target document's words
  or any tool's name — a task that can be answered by matching a word in
  a description measures the description, not the surface. The fixture
  (`scripts/eval/fixture.mjs`) is owned data, so every answer is true by
  construction; add what the task needs there.
- **Write tasks** carry a `verify(wb, ids)` that reads the state back
  through the real tools. Run `--dry-run` after adding one: the verifier
  must FAIL on the untouched fixture, or it would pass a model that did
  nothing. That is the mutation check, and the dry-run refuses to exit 0
  without it.
- **One task per question the surface should answer**, held out from the
  descriptions: refreshing tasks when descriptions are rewritten is part
  of the description increment, and a description may not quote a task.
- **A task that fails every trial on a frontier model is first suspected
  of being a broken task**, then of being a surface gap — the tag count
  was the second, and probing the store is what told them apart.

## Adding a tool

Beside the four-place list and the smoke call that
`mcp-smoke-coverage.ts` documents, a new tool lands with:

- every input parameter `.describe()`d — C3 counts down, never up;
- a `TOOL_PROFILES` entry with the honest worst-op annotation (C6, C7);
- the Zod OBJECT registered, not its `.shape`, so `.strict()` reaches
  the boundary and a stray key is refused by name (C10) — the way
  `wb_body_edit` and `wb_workspace_edit` already do;
- a description that says when to reach for it over its neighbours (C4);
- its rung-1 row, an errand in `mcp-errand-corpus.ts` if it changes what
  an errand costs, and a rung-3 task.

## Where the bytes go, and which cuts were free

Measured on the current table (ADR-0030 §3b): descriptions are ~30% of
what a model reads and are the useful bytes; the rest is schema, and the
schema carries three kinds of dead weight a `z.toJSONSchema` emits by
default. Check these before designing a bigger cut:

- **Safe-integer bounds.** `z.number().int()` emits `minimum:
  -9007199254740991, maximum: 9007199254740991` on every field — sixty
  times in one tool. Use the model's `integerSchema` /
  `nonnegativeIntegerSchema` (`.int()` validation, `.meta()` strips the
  bounds). `multipleOf(1)` is not the same integer: it accepts `1.4e-45`.
- **A stored union inlined per op arm.** The SDK round-trips a raw JSON
  Schema through `z.fromJSONSchema` and emits `$ref`s inlined, so dedup is
  impossible on the wire; it has to be the SOURCE schema. A flat
  write-side object narrowed on parse (`nodeExtensionWriteSchema`) cut
  the node extension from 487 bytes x8 to 290 x8, and made a broken embed
  a refusal instead of a silent drop.
- **`$schema` and `additionalProperties: false`.** 55 and 28 bytes a tool.
  The first is the SDK's and cannot be removed; the second is C10's price
  and is kept.

A description costs ~50 bytes each time it is emitted, and a field of the
node union is emitted once per arm per op: describing every parameter
would add ~40% to the table. Describe what the lane shows a model getting
wrong (the refusal texts), and let JSON Canvas fields mean what the spec
says.

## Traps, each paid for once

- **Run the lane from an EMPTY directory.** The `claude` CLI loads the
  working directory's `CLAUDE.md`, which in this repo names the tools the
  model is being tested on. The runner makes its own empty `cwd`; do not
  point it at a checkout to "save a copy".
- **The seeding server and the model's server are different processes.**
  Anything that survives only in memory is invisible to the model, and
  the first run found exactly that: comment threads and proposals were
  flattened to values by the workspace record's fold and came back
  unreadable after a restart (fixed; `comment-threads.durability.test.ts`
  is the shape of the test that crosses a reopen). A task that fails
  every trial on a read the fixture plainly supports is first checked
  for this: seed, close, reopen with `connectWhiteboard`, read.
- **`--only` is a substring over task names** — `--only=tag` matched two
  tasks. Quote the whole name for one.
- **Bytes, not tokens, on rung 1.** A tokenizer would make the pin depend
  on which model reads it. Divide by ~4 when quoting tokens, and say so.
- **Register the Zod OBJECT, never its `.shape`.** Handed a shape, the SDK
  rebuilds a non-strict object around it and a misspelt optional parameter
  is dropped with the call reporting success; `wb_facet_list`, every
  parameter of which is optional, answered the unfiltered list to any
  input at all. Every registration is the object now (C10), the rung-1
  `strays` column is `refused` for all 18, and a test holds it by name.
  The price was 29 visible bytes a tool for `additionalProperties: false`.
