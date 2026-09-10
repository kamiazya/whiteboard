# ADR-0031: The tool surface is judged by an instrument, not by its count

**Status:** Accepted

## Context

Two increments retired five tools in a week (`wb_body_patch` into
`wb_canvas_edit`'s ops, then the standalone document CRUD into
`wb_workspace_edit`), and each was measured on the errand scoreboard
(`tool-call-count-quality.test.ts`): calls per errand, request bytes,
response bytes. That instrument prices an errand **after the tool has been
chosen**. Nothing measured the choosing — what the tool table costs a model
to read on every turn, whether a model picks the right tool for a task it
has not been shown the name of, whether its first call is valid — and so
the next round of consolidation had only one number to steer by, and it was
the tool count. A count is the wrong currency: folding three tools into one
can leave the model reading exactly as much, and folding two overlapping
reads into one can cut what it reads in half without changing the count.

This ADR fixes the criteria first and the instrument beside them, so that
the retirements still to come are decided by measurements rather than by
the feeling that 18 is too many.

### What the surface costs today (measured 2026-09-09)

Read off a real `McpServer`'s `tools/list` over an in-memory transport
(`tool-surface-quality.test.ts`), so these are what a client receives.

| | |
|---|---|
| tools | 18 |
| model-visible bytes (name + description + input schema) | 34,960 (~8.7k tokens at 4 bytes/token) |
| wire bytes (the whole entry; output schemas are two thirds of it) | 102,525 |
| the largest tool, `wb_canvas_edit` | 15,829 visible bytes — 45% of the table |
| input parameters declared, at any depth | 324 |
| of which described | 25 |
| tools whose every parameter is described | 4 (`wb_version_*`, `wb_pairing_link_create`) |
| tools that silently DROP an unknown top-level key | 15 of 18 |
| tools that answer a schema-invalid call as a tool error, not a protocol error | 18 of 18 |

Two of those rows are debt the count could never have shown. 299 of 324
parameters are undescribed: ADR-0009 decision 6 said descriptions would
"land in the same increment as the renames, written as `.describe()` on
the Zod shapes", and they landed on four tools. And 15 tools hand the SDK a
`.shape` rather than the Zod object, so the SDK rebuilds a non-strict
validator around it and a typo'd optional parameter (`limt`) is stripped
rather than refused — the call looks like it worked.

### What the sources say

Read for this ADR, 2025–2026, in the order that matters here:

- **The cost that degrades an agent is tokens of tool definitions, not the
  tool count.** Anthropic measured ~55K tokens for 58 tools across five
  servers and 134K in one internal case, and names the trigger for
  loading tools on demand instead of upfront as "10+ tools" or ">10K
  tokens of definitions" (["Introducing advanced tool use"](https://www.anthropic.com/engineering/advanced-tool-use), 2025-11-24).
  Cloudflare's Code Mode collapses an API to two tools for the same reason
  (["Code Mode"](https://blog.cloudflare.com/code-mode-mcp/), 2026-02-20).
  The one measured degradation curve is RAG-MCP's, over 1–11,100 tools
  ([arXiv:2505.03275](https://arxiv.org/abs/2505.03275), 2025-05); the
  "30–40 tools" ceiling that circulates is asserted without method
  ([Speakeasy](https://www.speakeasy.com/mcp/tool-design), undated).
- **Consolidate around the errand, not the endpoint.** Anthropic's worked
  examples replace `list_users`/`list_events`/`create_event` with
  `schedule_event` (["Writing effective tools for agents"](https://www.anthropic.com/engineering/writing-tools-for-agents), 2025-09-11);
  Block took Linear from 30+ endpoint-shaped tools to two, and holds to
  **one risk level per tool** — never a read-only path and a destructive
  path behind one name (["Block's playbook"](https://engineering.block.xyz/blog/blocks-playbook-for-designing-mcp-servers), 2025-06-16).
  The MCP blog's reading of the annotations agrees: an unannotated tool is
  assumed destructive, non-idempotent and open-world, so omission is not
  neutral (["Tool annotations as risk vocabulary"](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/), 2026-03-16).
- **Selection among overlapping tools is decided by description wording,
  and swings by more than 10x on wording alone** across 17 models
  ([arXiv:2505.18135](https://arxiv.org/abs/2505.18135), EMNLP 2025).
  Two tools that read the same thing are therefore not disambiguated by
  better prose; they are merged, or one is retired.
- **Descriptions are lintable, and fixing them is not uniformly good.**
  Across 856 tools on 103 live servers, 97.1% carried a description smell
  and 56% failed to state their purpose; augmenting descriptions raised
  task success by a median 5.85 points and partial completion by 15% —
  and increased steps by 67% and regressed 16.67% of cases
  ([arXiv:2602.14878](https://arxiv.org/abs/2602.14878), 2026-02). A lint
  is an early warning; only a task-level eval says a rewrite helped.
- **Grade the outcome, not the path.** Checking that an agent followed a
  specific tool sequence "results in overly brittle tests, as agents
  regularly find valid approaches that eval designers didn't anticipate";
  reliability is pass^k (every trial passes), not pass@k
  (["Demystifying evals for AI agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), 2026-01).
  Anthropic's own MCP eval recipe is ten read-only, independent questions
  with single stable string answers, paraphrased so the question does not
  carry the target's words, solved by a real model with only the server's
  tools ([mcp-builder `evaluation.md`](https://raw.githubusercontent.com/anthropics/skills/main/skills/mcp-builder/reference/evaluation.md)).
- **Spec-level rules worth pinning:** a tool name is 1–64 characters of
  `[A-Za-z0-9_.-/]` (SEP-986); an input the schema rejects is a *tool*
  error the model can repair from, never a JSON-RPC error that ends the
  turn (SEP-1303) — both in the
  [2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog).

Two things the sources do not settle, decided below: whether the lever at
this size is consolidation or discovery, and how far one tool may carry
mixed-risk ops before its annotation is a lie.

## Decision

### 1. The criteria

Each is a statement a script or a reviewer can mark pass or fail, tagged
with the rung (section 2) that checks it. A criterion nobody checks is a
preference; the tag is what makes it a criterion.

| # | criterion | checked by | today |
|---|---|---|---|
| C1 | The model-visible size of the table (name + description + input schema, summed) is pinned, and a change says why it moved | rung 1 | 34,960 B |
| C2 | No single tool is more than a third of C1 | rung 1 | FAIL: `wb_canvas_edit` 45% |
| C3 | Every input parameter, at every depth, carries a description | rung 1 | FAIL: 299 undescribed |
| C4 | A description says WHEN to reach for the tool relative to its neighbours, not only what it does — the errand-level "use this over that" | review, and the `names` column of rung 1 as a hint | 3 of 18 name a neighbour |
| C5 | A tool corresponds to an errand step someone would name, not to a storage operation; two tools that read or write the same thing differently are merged or one is retired | rung 3 decides; review proposes | open, §4 |
| C6 | One risk level per tool: a tool is annotated for its worst op, and a tool that cannot be honestly given one `destructiveHint` is two tools | `tool-profiles.ts` + review | pass, with `wb_canvas_edit` and `wb_workspace_edit` DESTRUCTIVE for one op each |
| C7 | Every tool carries `title` and explicit `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` where they apply | `tool-naming.test.ts`, `tool-profiles.test.ts` | pass |
| C8 | Tool names are `wb_<entity>_<action>` (ADR-0009) and within SEP-986's format | `tool-naming.test.ts` | pass |
| C9 | A schema-invalid call is answered as a tool error naming the field, never as a protocol error | rung 1 | pass |
| C10 | An unknown top-level key is refused by name, never stripped | rung 1 | was FAIL (15 of 18 stripped, and `wb_facet_list` answered any input); every registration now hands the SDK the Zod object, +29 visible bytes a tool |
| C11 | An error message names what to do differently — the right parameter on the right tool, in the vocabulary of `vocabulary.md` | review; the smoke's `expectToolError` for the ones it exercises | was FAIL: `wb_document_list`'s not-found message told the caller to pass `createWorkspace`, a parameter of `wb_workspace_edit`, "along with the canvas"; the advice now follows the caller's intent (`document-crud.test.ts`) |
| C12 | A tool whose response can be large has a limit, a filter, or a stated truncation — never silent cutting | review | `wb_canvas_snapshot` and `wb_document_search` yes; `wb_document_get` caps how many documents, not how large |
| C13 | An errand costs the fewest calls the surface allows, and a consolidation that cuts calls says what it did to bytes | rung 2 | pinned |
| C14 | A real model, shown the tools and not their names, completes the fixture errands; a change to the surface does not lower that rate | rung 3 | §3 |

C1 and C13 are PRICE rows — no target, pinned so a trade is visible. C2,
C3, C10 are DEBT and target zero. The rest are pass/fail.

### 2. The ladder

| rung | instrument | runs | catches | cannot see |
|---|---|---|---|---|
| 0 | the existing guards: `tools/list` set parity with `ALL_REGISTERED_TOOLS`, the four-place list, naming shape, profiles, the smoke that calls every tool | every push | a tool registered wrong, missing, or misnamed | anything about how a model reads it |
| 1 | **the tool-surface scoreboard**, `tool-surface-quality.test.ts` over the oracle `test-utils/tool-surface-metrics.ts`: per tool, visible and wire bytes, description words, parameters and how many are undescribed, what a stray key gets, which neighbours the description names; the totals; and C9 for every tool | every push | C1–C3, C9, C10 moving, loudly, in either direction | whether a description is GOOD, whether a model would choose the tool |
| 2 | the errand scoreboard, `tool-call-count-quality.test.ts` | every push | C13: an errand that got dearer in calls or bytes | an errand nobody wrote; whether a model would find the cheap path |
| 3 | **the LLM-driven lane**, `pnpm --filter @kamiazya/whiteboard-mcp eval:tool-surface`: seeds a fixture workspace through the real server, hands each task in `scripts/eval/tasks.mjs` to a real model through the `claude` CLI with only this server's tools, from an empty directory, on its own copy of the data; grades by outcome (a string answer, or the state read back); reports calls, tools used, tool errors, tokens, cost, wall time, and pass@k / pass^k over `--trials` | on demand, before and after a surface change; skips where there is no CLI | C5, C14: a rename or retirement that made a model pick wrong, call wrong, or take longer | a task nobody wrote; it is non-deterministic, so one trial is a reading and `--trials=3` is a measurement |

Rung 3 is not in `pnpm test` and never will be: it spends API quota and
needs a network. `--dry-run` seeds the fixture and runs every verifier
against it without a model, and a write task's verifier must FAIL there —
a verifier that passes on the untouched fixture would pass a model that
did nothing, which is the mutation check the ladder needs before any
result of the lane is believed.

Why the `claude` CLI and not a framework (`mcp-eval`, `promptfoo`,
DeepEval's MCP metrics): it is the client the repo's `smoke:claude`
already drives, the lane is a few hundred lines, and grading is
deterministic because the fixture is owned — a judge model would add
variance to answer questions the store can answer exactly. Revisit when a
task needs a judge or the corpus outgrows a hand-written file.

### 3. What a rung-3 run says, and the baseline

The lane runs from an empty working directory with `--tools ""`,
`--strict-mcp-config` and `--disable-slash-commands`, so the model sees
the Claude Code system prompt, the server's `instructions`, and the tool
table — nothing that names a tool for it. The prompt names the workspace
id and the task, nothing else.

Baseline, 2026-09-09, one trial, the CLI's default model (`claude-sonnet-5`):

| task | verdict | calls | tools it reached for | tool errors | cost |
|---|---|---|---|---|---|
| who grants repository access | pass | 2 | `wb_document_search`, `wb_document_get` | 0 | $0.107 |
| count of process-tagged documents | **FAIL** — answered 0, wanted 2 | 1 | `wb_document_search` | 0 | $0.019 |
| label on the browser-daemon connection | pass | 2 | `wb_document_search`, `wb_canvas_snapshot` | 0 | $0.027 |
| button colour in the style guide | pass | 2 | `wb_document_search`, `wb_document_get` | 0 | $0.027 |
| box count on the roadmap | pass | 2 | `wb_document_search`, `wb_canvas_snapshot` | 0 | $0.027 |
| owner of the backup action item | pass | 2 | `wb_document_search`, `wb_document_get` | 0 | $0.027 |
| latest version label of the meeting note | pass | 2 | `wb_document_search`, `wb_version_list` | 0 | $0.027 |
| roadmap item with an open comment | **FAIL** — gave up | 19 | ten different tools, `canvas_view` three times, `wb_document_search` five | 1 | $0.202 |
| what the onboarding note links to | pass | 2 | `wb_document_search`, `wb_document_get` | 0 | $0.027 |
| add a box and connect it | pass — applied, not proposed | 3 | `wb_document_list`, `wb_canvas_snapshot`, `wb_canvas_edit` | 0 | $0.119 |
| add a tag without losing the others | pass | 5 | `wb_document_search`, `wb_document_get`, `wb_facet_set`, `wb_body_edit`, `wb_workspace_edit` | 2 | $0.060 |
| checkpoint every board | pass | 2 | `wb_document_list`, `wb_version_save` | 0 | $0.029 |

pass@1 **10/12**, mean **3.7 calls** per task, 3 tool errors, **$0.70** for the
run, ~10 minutes wall. Every two-call read cost ~69k input tokens: the
table is ~8.7k of that and the rest is the CLI's own system prompt,
which is why the lane reports cost beside calls rather than tokens alone.

What the two failures are, established by probing the store directly
rather than reading the transcript:

- **The tag count is a gap in the surface**, not in the model. There is
  no way to ask for documents by tag alone (§4), so one search with the
  filter answered nothing and the model believed it. A second trial of
  the same task PASSED, in four calls: the search answered nothing
  again, and this time the model listed every document and read them
  all. That is the pair pass@k and pass^k exist to separate — the task
  is answerable and not reliably answered — and the four calls are the
  price of the missing filter, which the errand scoreboard's row for
  this errand will pin once the filter exists.
- **The comment task sits on a durability bug the fixture exposed.** A
  thread added through `wb_thread_edit` is returned by `canvas_view`
  while the server that wrote it is alive, and is GONE once the data
  directory is reopened by a fresh process: `threads: []`, and a second
  `wb_thread_edit` on the same document then refuses with Loro's
  `Expected value type Map but found Value(Map(...))` — the thread was
  written as a plain value where the reader expects a child container,
  so it does not survive a snapshot round trip. Reproduced with and
  without a wait before closing, and with a later canvas edit; a
  markdown note's thread behaves the same. The model therefore searched
  a canvas that, to every read it had, carried no thread, and its
  nineteen calls are the honest result.

  **Fixed the same day**, and the cause was not Loro's: the workspace
  record's fold (`writeWorkspaceDocumentContent`) and projection
  (`projectWorkspaceDocument`) copied map entries through `toJSON()`, so
  a thread — a nested container so two peers replying at once converge —
  went into the record as a plain value and came back as one. Proposals
  had the same shape and the same loss. `syncMapEntries` now carries a
  nested container as a container through all four record paths (fold,
  projection, duplicate, version restore); `comment-threads.durability.test.ts`
  and `proposals.durability.test.ts` cross the reopen no in-process test
  crossed, and fail without the fix. Re-run, the task passes 2 of 2 in
  two calls.
- **The tag write passed, and never the same way twice — because no
  tool could do it.** Three trials reached the state by three routes:
  `wb_facet_set`, refused twice, then a rewrite; `wb_body_edit` twice,
  `wb_facet_list`, then a whole-document rewrite through
  `wb_workspace_edit`; `wb_body_edit` once ("Passage tag1 does not apply:
  its passage is no longer in the body"), `wb_facet_list`, then the
  rewrite. The first reading of this was "the model never considered
  `wb_facet_set`"; the refusal texts (`toolErrorTexts`, which the lane
  now records) said otherwise: `facets.tags: extension facet key "tags"
  must match {namespace}.{name}/v{n}`. Tags are OKF *core* frontmatter and
  `wb_facet_set` accepted only extension facets, so "tag this note" had
  no tool, and the model's rewrite of the whole document was the only
  correct answer the surface offered. C5, not C4: an errand step with no
  tool behind it.

  The same probe caught the errand scoreboard lying. Its "tag 5
  documents" errand sent `facets: { 'core/v1': ... }`, a key the tool
  never accepted, and counted the refusal as one cheap call for a week;
  "save a labelled version of 4 documents" measured a harness that
  supplied no `versions` seam and answered a crash the same way. A
  refused call is now a thrown one in the corpus, and both rows are
  re-pinned on real writes.

  Landed: `wb_facet_set` takes `tags: { add, remove }` (the errand's
  shape, so one payload tags five notes that each keep their own), every
  parameter described, and a description that says so. Rung 3 on the
  task, three trials: 5.7 calls and 7 tool errors before, **2 calls and
  0 errors after**, pass^k 1 both times. Rung 1: +1,122 visible bytes,
  four fewer undescribed parameters.


Read the table as the sources say to: the pass column is the gate and the
calls column is the diagnostic. A task that passes in seven calls where
the errand scoreboard's cheapest path is two is not a failure of the
model; it is C4 or C5 unmet on the tools it wandered through, and it says
which.

### 3b. The second reading, after one round of tuning (2026-09-09)

Same lane, same twelve tasks, one trial, after the increments §6 records
as landed (threads survive a restart; `wb_facet_set` tags; the search
filter stands alone; every tool refuses a stray key; `wb_document_resolve`
retired; integer bounds gone):

| | baseline | after |
|---|---|---|
| tasks passed | 10 / 12 | **12 / 12** |
| mean calls per task | 3.7 | **2.0** |
| tool errors | 3 | **0** |
| cost of the run | $0.70 | $0.56 |
| tools | 18 | 17 |
| model-visible bytes | 34,960 | 33,251 (34,617 once the text anchor was described, below) |
| undescribed parameters | 299 | 283 (265) |

Every task that had wandered now takes the two calls its errand needs (a
search to find the document, one read or write), and the table a model
reads shrank while gaining two capabilities. Two more write tasks were
added after this reading — a passage edit through `wb_body_edit` and a
reply through `wb_thread_edit` — because those two tools had no task and
the baseline's refusal texts showed a model reaching for `wb_body_edit`
with the wrong anchor shape.

**What the byte column was bought with, in order of size:**

| cut | visible bytes | what it cost a model |
|---|---|---|
| safe-integer bounds off every `.int()` field (`integerSchema` in the model) | -1,912 | nothing: `{ "type": "integer" }` says what the bounds said |
| the node extension a writer sends as one flat object, narrowed on parse | -1,320 | nothing, and a broken embed is now refused by name instead of silently dropped |
| `wb_document_resolve` retired | -442 | nothing: a list row carries the id and the path |
| `additionalProperties: false` on every tool (C10) | +464 | a stray key refused instead of dropped |
| `tags` on `wb_facet_set`, all parameters described | +1,122 | a tool for "tag this note" |
| the search filter standing alone, all parameters described | +379 | one call for "every document tagged X" |
| the text anchor and the body change described (`wb_body_edit`, and `wb_thread_edit`'s anchor union) | +1,366 | the passage-edit task: 1 refusal in 2 trials before, 0 in 3 after — the first C3 payment made on evidence |

**What did not work, so nobody tries it twice.** `$ref`/`$defs`
deduplication is the obvious cut for `wb_canvas_edit` (the node union is
inlined once per op arm, and the SDK accepts a raw JSON Schema), but the
SDK round-trips a raw schema through `z.fromJSONSchema` and emits it
INLINED again: measured, a two-arm schema with one `$ref` listed with the
definition copied into both arms. Dedup has to happen at the source
schema, which is what the flat extension did. `multipleOf: 1` as an
integer form emits 40 bytes less than `.int()` but accepts a denormal
(`1.4e-45`), which the model's own property test caught; `.meta()`
overriding the bounds keeps `.int()`'s validation.

**C3 against C1, decided.** Describing the 283 undescribed parameters at
the ~50 bytes a `.describe()` costs would add ~14,000 bytes — 42% of the
table — most of it on JSON Canvas 1.0 fields (`x`, `y`, `width`, `text`,
`fromNode`) whose meaning is the spec's and which the lane shows models
writing correctly with no description at all. So C3 is paid down where
the lane shows a model guessing wrong (a refusal text naming the
parameter), tool by tool, and JSON Canvas fields inherit their spec's
meaning. The `undescribed` column stays honest; it is a debt with a
price, not a debt to clear blindly.

### 4. What the instrument is now pointed at

These are questions for the lane, deliberately not decided here. Each
names the criterion it is about and what a rung-3 run has to show before
anything is retired.

- **Four ways to read a canvas** — `wb_document_get` (JSON Canvas),
  `wb_canvas_snapshot` (compact, no threads), `canvas_view` (scene plus
  threads, a UI tool by ADR-0009 point 7), `wb_scene_render` (SVG). C5.
  The "roadmap item with an open comment" task is the probe: only one of
  the three data reads answers it.
- ~~Four tools on the document noun~~ — `wb_document_resolve` is
  retired: its one answer, an id's path, is a column of every
  `wb_document_list` row, so no errand lost a way to be done and the table
  lost 442 bytes. The lane's baseline had it reached once, by a model
  wandering. `list`, `search` and `get` stay: a listing, a filter and a
  read are three errands.
- ~~A question the surface cannot answer in one call~~ — "how many
  documents carry tag X", found by the lane's first run: `wb_document_search`
  required a non-empty `query` and its `tags` filter only narrowed text
  matches, and a tag is not searchable text, so `query: "process",
  tags: ["process"]` answered nothing for two tagged documents. Landed:
  the filter stands alone (`query` optional; neither words nor a filter is
  refused and points at `wb_document_list`). Rung 3 on the task, three
  trials: 3 calls each before (a search that answered nothing, then a
  list and a read of every document), **1 call each after**, pass^k 1
  both times. Rung 1: +379 visible bytes, two fewer undescribed.
- ~~`wb_facet_set` does not say "tags"~~ — it could not tag at all (C5,
  §3); landed as `tags: { add, remove }`, judged by the lane's tag-write
  task.
- **`wb_facet_list`** — a schema lookup with no required parameter, which
  answers an unfiltered list to any input (C10). Whether an agent ever
  needs it, or `wb_facet_set`'s refusal should carry the schema instead.
- **`wb_canvas_edit` at 39%** (C2; was 45%). The ops union repeats the
  full node and edge schemas per arm, and `$ref` is not available (§3b),
  so what remains is the union itself: `region.set` carries the node
  union a second time and `node.add` the first. Measured before deciding
  anything about `region.set`'s shape (2026-09-09): the arm is 3,930 of
  the ops union's 11,431 bytes (34%; `nodes` 3,126, `edges` 597), so it
  is a third of the tool for one op. Rung 2 pins the op itself at one
  call, 426 request bytes for a group plus three geometry-less boxes,
  1,954 back. Rung 3 on the errand the op was built for ("make this
  group contain exactly these three"), a fixture group 700 wide already
  holding two boxes, nine trials over three runs: pass^k 1, 3 calls each
  (search, snapshot, edit), and **the model reached `region.set` in two
  of the six trials whose ops were recorded** — the other four got the
  same outcome from `node.add`, once after widening the group with
  `node.patch` and once after shifting a box over. Both `region.set`
  calls declared full geometry for every box, none left a position to
  placement; one was refused (`node "mobile" would not be inside
  "clients"`, right edge 760 in a group of 700) and the retry shrank
  everything to fit. Placement has the same edge: at 700 wide the
  corpus's own three default-size boxes wrap to a second row that does
  not fit, and the whole batch is refused with a text that says which
  box and not how wide the group would have to be. So the op is reached
  a third of the time on its own errand, costs a third of the tool to
  offer, and its refusal has no repair advice — three findings, none of
  which yet says which shape to change to.

  Landed first, because it is the cheapest and changes no shape: the
  group GROWS to hold what placement put in it (a locked one refuses and
  says the size it would need), the refusal for a caller-chosen position
  names the edge and the overrun and the three ways out, and `nodes`
  carries one description saying geometry can be omitted (+168 bytes,
  the tool's first described parameter). Three lane steps, three trials
  each, same task: growth and the refusal text alone — reached 2 of 3,
  the one refusal repaired the way the text said (widen with
  `node.patch`, in the same batch) instead of by shrinking every box;
  still full geometry on every node. The description added — reached 3
  of 3 and the new box left to placement in all three, **and every trial
  then spent a fourth call moving it**: placement had started from the
  group's top-left as if it were empty and put the new box on the first
  one. A follow-up call after a write is the lane grading the write's
  RESULT, and that one was a product bug the op had carried since it
  shipped. Placement made to pack around what the region keeps — reached
  3 of 3, no follow-up call, one trial declaring no geometry at all, the
  one refusal repaired by omitting x/y as advised. What this did not
  move: the arm's 3,930 bytes, and the model's habit of writing
  x/y/width/height for a box that already has them.

  **Landed second: `region.set` names members by id, and a member is
  created by `node.add` with `within`.** The node union left the arm
  (rung 1: `wb_canvas_edit` 13,066 -> 9,675, the table 34,785 -> 31,394,
  parameters 317 -> 254), and with it the place the habit lived. Rung 2:
  the errand's request 425 -> 549 (three `node.add` wrappers instead of
  one declaration list), response unchanged. Rung 3, the group task,
  three trials: reached 3 of 3 — and every trial was refused once. The
  model wrote `within` AND the next slot in the row (x 560, right edge
  760 in a group of 700), which the description had promised the group
  would grow for; the refusal contradicted the description. So growth
  applies to a positioned node too, and only a position before the
  group's top-left — the one thing growth keeps — is refused. After: 3
  of 3 reached, 3 calls each, 0 refusals, $0.138 for three trials
  against the baseline's $0.151. Two shapes stayed in the payloads a
  reader should expect: the model still positions a new box by hand when
  a row is visible to extend, and one trial closed with `tidy` on the
  group.

- **Server-decided geometry, measured and not acted on.** The hypothesis
  that an op should be able to name an earlier op's OUTPUT — the group's
  box depending on where three placed nodes landed — was given its own
  task ("add three boxes in a row, chained, inside a group labelled
  Pipeline"). Three trials, three passes, three calls, one edit each:
  the model computed every coordinate itself, group included, in one
  batch, and after `within` landed it did the same with `within` on each
  box. No round trip to read a placement, no refusal. A reference syntax
  would have saved output tokens on a task the surface already does in
  one call, at the price of a mini-language the schema cannot validate
  (C3, C11) — not a trade the lane can be made to show a gain on. Kept
  as a task so a shape that WOULD need it is noticed when it appears.
- **A set, measured as a selector.** Proposed: a batch-scoped named set
  an op pushes into, then operated on in bulk. Two tasks were written for
  the shape — "colour every box inside the Clients group" and "lock every
  item on the roadmap" — and the baseline said what the cost actually
  was: three calls each, the middle one a snapshot whose only purpose was
  to learn the ids the edit would then name one by one. The accumulator
  half could not move that (every id a model creates it also chooses, so
  it never needs a set of its own outputs); the SELECTOR half could.
  Landed as `within` and `all` where an op takes one id (+1,095 visible
  bytes, eleven parameters, all described). After, three trials each: the
  lock errand went 3 -> 2 calls in two of three (snapshot skipped, `all`
  on nodes and edges in one batch), the colour errand stayed at 3 calls
  but went from two ops to one — `within` needs the group's id, and the
  snapshot is still where that comes from. Six of six trials reached for
  the selector unprompted. What would take the colour errand to two calls
  is a selector by LABEL, which is a lookup with no uniqueness behind it;
  left as the next candidate rather than added on the same evidence.
- **The use-case axis, measured with pictures.** "Can the surface draw
  what a person actually asks for" is C5, and no task had asked for a
  LAYOUT. Two now do: a three-layer architecture diagram (groups stacked
  in order, members inside and lined up, nothing overlapping, eight
  connections) and a sequence diagram (participants as columns, messages
  between their two participants, each lower than the last). Both pass
  six of six, one edit call each, every coordinate written by hand —
  around 3k output tokens for the architecture drawing, and the numbers
  right. The runner now keeps a rendering of every board a write task
  names beside `--out`, because a verdict cannot carry what a drawing
  looks like, and the first pictures found two product bugs the grader
  (which reads the store) had passed: `wb_scene_render`'s SVG had no
  viewBox, so a layer drawn at y=0 lost its label off the top; and a
  coloured group whose id sorted after a member's painted OVER it — four
  of eleven boxes gone from a diagram that scored as correct. Both fixed
  in canvas-render's envelope and paint order.

  On the same tasks, the push-then-arrange idea was given its cheapest
  form — `below` and `rightOf` on `node.add`, a position the server
  computes from a node an earlier op placed, so a grid needs no
  arithmetic — and REVERTED: six trials of six wrote every coordinate by
  hand with the relations in the table and described, zero reached for
  either, for +261 bytes. A model drawing a whole diagram plans the
  picture globally and writes it in one pass; a chain of relations is
  the incremental style, and it did not want it. Recorded so the shape
  is not re-proposed on the same evidence; a different shape (a whole
  `layout` op that takes rows of members, say) would need its own
  measurement, and the diagram tasks are where to take it.
- **A stray key inside a node draft is accepted silently** (C10, one
  level down). A trial wrote `"height80": true` beside `"height": 80`,
  and the write succeeded: the per-type node schemas are non-strict so a
  document may carry another tool's extension keys, and the draft
  inherits that. The top-level strays test cannot see it. Worth a write-
  side `.strict()` on the draft — this tool writes only what it knows —
  judged by the refusal text a typo then gets.
- **What a call answers with**, the errand scoreboard's `responseBytes`
  column, is the other half of what a model reads and was untouched until
  the version tools stopped answering the History panel's row (1,948 ->
  1,316 for four saves). What remains by size: `wb_canvas_edit` answers
  the resulting board (a truncated snapshot, ~2,500 of the "author a
  canvas" errand's 3,172 bytes) so a drawing flow needs no read after each
  edit — kept, because the read it saves is a whole call. `wb_scene_render`
  answers SVG text, 1,800 bytes for a four-box board: cheap, but markup a
  model cannot LOOK at. An image content block (PNG through the daemon's
  resvg, ~500 tokens for 1000x380) would let a vision model judge a
  layout it drew; that is a capability (C5) rather than a cut, and its
  lane task would have to be graded on a layout property the store can
  check.
- **The description debt** (C3, C4). 299 parameters, and the four
  tools that have none owed are the shape to copy. Landed in increments
  that the rung-1 `undescribed` column counts down, and each increment
  checked against rung 3 rather than assumed to help (the smells paper's
  16.67% is why).

### 5. The lever at this size

Consolidation and description work, not discovery. At ~8.7k tokens the
table is under the line at which Anthropic's guidance stops loading a
table upfront, and every retirement in §4 moves C1 down rather than up.
The rung-1 total is what makes the crossing loud: if C1 passes ~40,000
bytes (~10k tokens) — because a tool grew, or a new one landed — the
question changes from "which tool goes" to "does this server offer a
search over its own tools", and that is a new ADR, not a bigger cut.

### 6. What lands with this ADR, and what is filed

Lands: the criteria above; the rung-1 scoreboard and its oracle,
calibrated; the rung-3 lane, its fixture and twelve tasks, and the
baseline in §3; the `mcp-tool-surface` skill, which is the procedure a
change to the table follows, and the opt-in `tool-surface` review
dimension, which judges the diff by the same criteria.

Filed as follow-ups, each its own increment with the scoreboards as
its evidence:

- **Workspace records flattened before the container fix.** The fold now
  carries a thread or proposal as a container, and a record that holds a
  VALUE where a later save brings a container is replaced. What nothing
  repairs is a record flattened by the old fold whose projection is then
  saved back unchanged: the plain value is copied out and synced in as the
  same plain value, so readers keep skipping it. Those threads were already
  unreadable under the old code — nothing that worked stops working — and
  the repair belongs to the readers, which know which keys hold containers;
  an increment of its own, with a durability test that projects a flattened
  record and writes a message into it.

- ~~A comment thread does not survive a restart~~ — landed (§3): the
  record's fold and projection now carry nested containers.
- ~~C10: register the Zod object rather than its `.shape`~~ — landed for
  all 18, 464 visible bytes for the whole table.
- ~~C11: `WorkspaceNotFoundError`'s message~~ — landed.
- ~~A tags-only query~~ — landed; the "count of process-tagged documents"
  task is the regression test.
- ~~`edge.add`'s sides~~ — landed (§7): described on the stored schema;
  the lane's architecture board owes no debt in three trials of three.
- C3, in the order §4 gives.
- The §4 retirements, each with a rung-3 before/after.

### 7. The drawing score (2026-09-09)

§3 grades a layout task by the state read back — every box inside its
layer, no two overlapping — and the lane passed drawings a reader would
not have: the two rendering bugs §4 records were found by looking, on
boards the verifier had accepted. A verdict plus a picture leaves the
distance between "passes" and "usable" to whoever opens the SVG, and a
sweep that moves that distance has nothing to report.

So the lane now records, per board a write task names, canvas-render's
`scoreDrawing` (`packages/canvas-render/src/quality/drawing-score.ts`):
debt columns that each name a mistake a reader would see — boxes over
boxes, a box across a frame, an edge through a box it does not connect, a
label over a box or under a frame, cut content, a cramped member, a box
a few pixels off its row — and price columns for what a clean drawing
costs in crossings, bends, ink, gaps and envelope. Calibrated by planting
one defect and reading one; pinned in `drawing-quality.test.ts` over the
two diagrams the lane asks for, each as a reference, a first attempt and
the attempt after tidy. That last pair is the reason the instrument is
worth having before the next surface change rather than after: the first
reading showed tidy leaves every mistake INSIDE a frame where it was,
because a frame and its members move as one unit — a product finding no
verifier and no pass column could have surfaced.

The first reading over the two diagram tasks (one trial each, both
passed in two calls with no tool error, $0.19 together) split the debt by
who owes it. The model's part was clean on both boards: not one box
overlapping, straddling, cramped or off its row. The sequence board had
no debt at all. The architecture board had two edges through a box for
174px and one crossing, and the recorded inputs say whose: the model
wrote `fromSide: 'bottom', toSide: 'top'` on all eight edges — the sides
that suit a layer-to-layer edge — including API gateway's two to the
boxes beside it on the same row, and the router honours a pinned side.
Those two leave from the bottom, loop under and back over, tunnel
through API gateway itself and cross the Web app edge. The same board
with the sides removed owes no debt at all, at the router's own price of
two crossings — which is how the cause was found, since a first
reconstruction of the board had dropped the sides. So the first surface
question the column raises is
what `edge.add` says about sides: a description that leaves them to the
router unless the drawing needs one, or a router that treats a pinned
side as a preference it may overrule. The board is in the corpus as
`lane/architecture`, sides included, so either fix is measured against
it.

**Answered by the description (2026-09-10).** `fromSide`/`toSide` now say,
on the stored edge schema every writer derives, that omitting them lets
the router keep the line clear of other boxes while a named side is kept
even through one. Rung 3 on the architecture task, three trials before
and after: the model wrote sixteen sides a trial before and none after,
and the board's debt went from 2, 3 and 2 edges through a box (145–163px)
to **no debt in every trial**; crossings 1, 4, 1 before against 1, 2, 0
after. Rung 1: +508 visible bytes, four fewer undescribed parameters
(edge.add and edge.patch each carry both sides); pass^k 1 both times. The
router half of the question was measured and REJECTED first — two side-choice
changes each raised the sweep's debt while cutting the reference's
reversals — and `package-canvas-render.md` carries that matrix.

**The second surface reading, and what it found in the instrument
(2026-09-10).** With the sides described, every board the lane's tasks
drew read debt-free three trials of three — the two diagrams, the box
added to the architecture board, the pipeline wrapped in a group. So the
lane gained two tasks that stress what those never did: a box INSERTED
between two connected boxes in a row whose gap is narrower than a box,
and a state diagram with a transition that goes back. The state diagram
came out debt-free (one arrow against the flow, as drawn). The insert did
not, and what it owed was mostly invisible: the model narrowed the box to
150 and centred it in the 200px gap, leaving 25px each side with "libsql"
over the boxes its edge joins — `labelOverNode 2` — and in one trial set
the box flush against both neighbours, which read as NO debt. Nothing in
the column set judged the space between two boxes; `nearMisses` judges
whether they line up. `tightGaps` now does: pairs of boxes side by side
with under 32px between them, touching included — twice the frame padding,
set from that reading rather than a catalogue, since ELK's default node
spacing (20) and tidy's own margin (24) would both have passed the 25px
board. Tidy's margin is raised to the same 32, because the invariant that
tidy never adds debt held only until the score could see a jammed row:
its scoreboard pays 23% more displacement for it, and 42 more pairs stay
within the margin around a locked obstacle, re-pinned with the reason.
The board is in the corpus as `lane/insert` (`tightGaps 2, labelOverNode
2`), so whatever makes room for the box — a surface that offers it, or a
model that moves the neighbour — is measured against it. The summary now
also carries `debtFreePowK`, the share of drawing tasks whose boards owed
nothing in every trial, beside pass^k: 4 of 5 on this reading.

**The third reading: room for the box, and where its label goes
(2026-09-10).** Two changes, each measured on the insert task three
trials at a time. First a sentence in the server instructions — boxes
need about 32px between them, and a box going between two others means
moving the neighbours over in the same batch, not shrinking it or
squeezing it in. With it the model patched SQLite right and kept the box
its full width in every trial: `tightGaps 2 → 0, 0, 0`, with 50, 50 and
40px gaps. What stayed was `labelOverNode 2, 2, 4` — "libsql" on a 40–50px
edge is wider than the edge and lay over both boxes it joined, which no
instruction to a model should have to solve. So the renderer solves it:
`edgeLabelPlacement` keeps the midpoint unless a label of that size would
lie over a box, and then slides it off the line along the segment's
normal, nearest clear offset first, above before below; the editor's
inline label editor opens through the same producer. After both, the task
read no debt three trials of three, `debtFreePowK 1`, at two calls of
drawing per trial; the two boards are in the corpus as `lane/insert`
(`labelOverNode 2 → 0`, still `tightGaps 2`) and `lane/insert-roomy`
(debt-free). What this round did not need was a placement affordance on
`node.add` — a `between` that shifts the row — because a sentence was
enough for the model to do the arithmetic itself; the affordance stays
filed for the day a reading says the sentence is not. The whole lane,
one trial each after this round: 14 of 14 passed, every one of the 8
boards its tasks drew debt-free (`debtFreePowK 1`), 2.4 calls a task, 0
tool errors, $0.87 — the instructions sentence changed nothing else the
lane can see.

**The fourth reading: a box too short for its text (2026-09-10).** With
the whole lane debt-free, two more tasks: a box holding a long sentence
added beside existing boxes, and a flowchart with a retry loop. The
flowchart came out debt-free three of three. The sentence read
`textOverflow` in one trial and `nearMisses` in another, and the size the
model named explains both: 220×100, or 200×100 twenty pixels off the
column it sat under — the neighbours' size, copied to match them.
Describing `width` and `height` on the stored schema ("omit it and a text
box is made tall enough for its text; a named one is kept even when the
text does not fit") moved nothing: three trials of three named 200×100
and the sentence was cut, which is the study's finding that a
description fix regresses a sixth of cases, here with the whole sixth in
one place. The recorded decision that a named height is kept however
small — "someone who asked for 40 gets 40" — was made without a reading,
and the reading is that the writer who names a height is a model copying
its neighbours, so the tool now refuses a text box whose named height
cannot hold its text at its width and says the height it needs, on
`node.add` and on a `node.patch` that changes text or size; the
description says so. After that: two trials omitted the height and were
fitted, one named 200×100 and was NOT refused — the daemon measures with
its real font and the text fits there, while the score measures with the
ratio measurer every machine has and reads one line more, `textOverflow
1`. That was an instrument gap rather than a drawing defect, and it is
closed on the tool's side: the fit takes the taller of the two readings,
its own font's and the ratio measurer's, so what the tool accepts is what
the score and a client drawing with a wider font would accept, at the
price of a box a line taller than the daemon's font strictly needs. Read
again with the floor: no debt three trials of three, no tool error, and
the task's `debtFreePowK` back at 1.

**The fifth reading: the whole lane again, and what tidy left inside a
frame (2026-09-10).** With the round-4 instruction in place ("end with a
tidy op scoped to the boxes you added"), the whole lane over three
trials read `debtFreePowK 0.7`: seven of the ten drawing tasks debt-free
in every trial, and the three board-editing tasks each owing one trial —
`nearMisses 1` (a box added at y=300 beside row-mates at 300, which the
scoped tidy snapped to the grid's 304), `crampedMembers 1` (a member
placed flush with its frame's bottom edge), `crampedMembers 3` (a frame
sized exactly to its three members, then a tidy scoped to them). All
three are one finding, measured on the fixture: tidy never looked inside
a frame — `within: <group>` and a scope naming a member both returned
nothing, and an overlapping member stayed overlapping — so the
instruction sent models to an op that could not do what it was asked.
Tidy now tidies inside a frame and grows it to hold its members with the
32px margin (`package-canvas-render.md` has the three rules around it and
what each was measured on), a band that holds an immobile box aligns to
that box rather than the grid, and the tool keeps its own gutter when it
places a member so a placement is never flush. Read again, the three
tasks came back debt-free three trials of three each, with no tidy op
issued in the `add a box` trials this time — the near-miss fix is
exercised by its unit example and the corpus, not by the lane. The
drawing-corpus row `architecture/tidied` moved with it: overlap 1 to 0,
cramped 2 to 0, near misses 5 to 2 (members of different frames, which
no band sees), at the price of one crossing; the grouped tidy
scoreboard's `stillOverlapping` went 283 to 0. The same reading traced
the architecture task's `bends 6, reversals 3`: it is the router's cost
model choosing zero crossings over a loop, given where the model put the
gateway — a placement finding, recorded beside the rejected router
matrix so the search is not traced again.

**The sixth reading: the whole lane on the tidy-inside-frames tree
(2026-09-10).** 24 of 24 pass; the three board-editing tasks that owed a
trial each are debt-free three of three; `debtFreePowK` stays at 0.7
because three OTHER tasks now owe one trial each, and a whole-lane
reading is a different set of drawings every time. Two of the three were
the same finding, and it was the instrument's: a flowchart whose 200-wide
decision box is centred on a 160-wide column (`nearMisses 4`), and a
220-wide sentence box centred under a 200-wide one (`nearMisses 1`). Both
are aligned on the anchor the drawer chose, and the column judged the
left edge alone. It now judges the nearest of the three anchors on an
axis (left/centre/right, top/middle/bottom), and only boxes against boxes
and frames against frames — the first draft of that charged a box for
sitting 6px off the centre of the 800-wide frame beside it. Rescored, both
boards read 0; the corpus moved as pinned (`architecture/drafted` 5 to 3,
`sequence/drafted` 2 to 5, each with its reason). The third is a router
finding for the next reading: on one architecture trial a client's edge
left its box's top, hooked, and cut back through its own box on the way
down (`edgeThroughNode 1`, 63px of its own source) — the search's
endpoint-body-ink tier sits below crossings, so a route through its own
box outranked a crossing. Whether that order is right is a population
question for the 2000-layout sweep, not a reading of one board.

Traced, it was not the order. The search costed that route at ZERO
self-ink: every ink term in the router reads axis-aligned segments only,
and the straight style's routes are diagonals, so a diagonal back through
the edge's own box was invisible to the search and visible to the score.
Two changes were measured. Swapping the tiers (endpoint-body-ink above
crossings) moved nothing on the board — the term was blind either way —
and on the orthogonal sweep bought `own-endpoint` 12 to 5 for crossings
494 to 686; rejected, and recorded beside the other router matrix. Reading
the diagonal moved the board: the search then takes a bottom-to-right
route with one crossing over the loop back through its source
(`edgeThroughNode 1` to 0, bends 3 to 2, reversals 2 to 1, crossings 0
to 1). It is charged at the intrusion tier, not the endpoint-body-ink
one: every legitimate straight route has zero of it, since the diagonal
runs from one stub's end to the other's, both outside their boxes — it is
the straight style's form of the retrace the orthogonal style already
charges there. The orthogonal sweep is untouched by construction (no
diagonals), and the drawing corpus moved on one price only.

**The seventh reading (2026-09-10).** The whole lane on the tree with the
intrusion fix: 24 of 24 pass, `debtFreePowK` 0.8, two trials owing. One
was the instrument's again: a sentence box whose text-fitted height put
its bottom edge 10px from a box in another column — a bottom is where the
text ended, not an anchor anyone set, so the column now judges top and
middle on the vertical axis and all three anchors on the horizontal one,
where the width is named. The other was a model pinning `bottom/top` on
every edge of the architecture board, same-row pairs included: the search
honoured the pair into a stub down and a diagonal up through both its own
boxes (`edgeThroughNode 2`, 140px), the very defect the sixth reading
taught it to see. A named side asks where the line attaches, and a line
through the box it attaches to satisfies nobody, so such a pair is now
overruled and the edge re-sided; the board reads no debt with the sides
the model named. Letting a lone edge reach the search along the way
moved the orthogonal sweep down on every column (`foreign` 15 to 7,
`own-endpoint` 12 to 10). Five tool errors this round, up from two: two
height refusals working as designed, and three from one shape — a model
adding boxes and then a group meant to hold them in one batch, writing
`within: null` or the group's own id on the group, then finding
`region.set` on a second call. That is the surface's next item.

**The `within` description (2026-09-10).** `within` on `node.add` now
says a group must be on the canvas or added earlier in the batch, and
that wrapping boxes that already exist is add-the-group-then-`region.set`;
the refusal for a `within` that is not a group says the same. Rung 1:
+124 bytes on `wb_canvas_edit`. Rung 3 on the wrap-a-chain task, three
trials: tool errors 3 to 0, calls 4.67 to 4.33 a trial, every board
debt-free — each trial added the group and `region.set` in one batch
where the round before wrote `within: null` or the group's own id on it.

**The eighth reading (2026-09-10).** The whole lane with the `within`
description: 24 of 24 pass, tool errors 5 to 0, `debtFreePowK` 0.8, two
trials owing. One was a model's arithmetic: three frames whose centres
sit 20px apart, drawn that way and kept by tidy (`nearMisses 2`) — a
whole tidy moved nothing on that board, since its bands read left and
top edges while the score accepts centre and far edge too. Tidy now
bands on those anchors as well, and the board reads no debt after one;
what the surface cannot do is make a model run that tidy, and this one
ran three scoped to a frame's members instead. The other was the surface's, and every
wrap-a-chain trial paid for it: each sent one batch — three boxes in a
row, two arrows, a group with no geometry, `region.set`, `tidy` — and then
two more calls putting the boxes back where it had drawn them and sizing
the frame by hand, since the group had landed at the cursor's default
spot and `region.set` had pulled the row into a column inside it. The
hand-sized frame is where the one `crampedMembers` came from. So a group
added in the batch with no position, still holding nothing, is placed
around the members it is set to — their bounds plus the gutter, never
smaller than a size it was given, refused when the box would swallow a
bystander and nested when a frame already holds them — and `region.set`'s
description says so. Rung 1: +104 bytes on `wb_canvas_edit`. Rung 3 on
the task, three trials: calls 5.0 to 3.0, one batch each, every board
debt-free.

**The ninth reading (2026-09-10).** The whole lane with `region.set`
placing an unpositioned group around its members and tidy banding on
centres: 24 of 24 pass, `debtFreePowK` 0.9, three tool errors. The one
owing trial was the layered board again, its frames two pixels off
centre after a tidy — the server the lane had started ran the banding
before its fixpoint guard, and the guarded tidy reads that board at no
debt. The errors were two shapes. Two trials wrote `within: null` on the
group's own `node.add`, the description notwithstanding: a model saying
"no group" as null is not wrong, and the refusal cost the whole call, so
`within` now takes null as none. The third was the `node.add` twin of the
eighth reading's finding — a group added with no geometry, then its
members positioned and `within` it: the group had landed at the cursor
(x=440, beside the first) and the member at x=40 was refused as before
its top-left. A group this batch placed at the cursor is now placed
around what goes in it, growing in every direction as members arrive,
with the same wall and nesting rules as `region.set`, and `within`'s
description says so. Rung 1: +107 bytes on `wb_canvas_edit`. Rung 3 on
the layered task, three trials: tool errors 1 to 0, calls 4 to 2.67 a
trial, every board debt-free; the wrap task 3 of 3 at 3 calls. The first
after-run refused two trials with the new wall message, and that was a
second finding: a model adds all its groups first, the cursor puts them
side by side, and one group's box around its members reached the next,
still-empty one — and that empty box, covering a member of the first by
accident, read as holding it. A cursor-placed group now holds nothing
until it has been placed around something, whatever its box covers.

**The tenth reading (2026-09-10).** The whole lane with tidy banding on
centres and a cursor-placed group following its members: 24 of 24 pass,
`debtFreePowK` 1.0 — every one of the thirty drawn boards debt-free — no
tool errors, 2.375 calls a trial, the fewest yet. Five readings moved the
column from 0.7 to 1.0, and what moved it was never one thing: two tidy
rules, two score rules, three router rules, and four things the surface
said or did about groups. The debt criterion is saturated on this lane,
which says as much about the lane as about the surface: ten drawing tasks
of five to eleven boxes. What the boards still differ on is PRICE, and
only one of them differs at all: the layered architecture board reads
crossings 2, 1, 0 and reversals 2, 1, 3 across its three trials, with the
same-row loop of the fifth reading behind the worst — the cost model's
answer to a gateway placed beside the services it fans out to, a
placement the drawer chose. So the next criterion is price on that board,
and the next question is whether the surface can say where a fan-out box
goes before the router has to pay for where it went.

What the column does not do is gate: a task passes or fails on its
verifier as before, and the score is read beside it the way `calls` is,
as a diagnostic that says where the surface let the model draw badly. A
rung for "the model's drawings read well" — pass^k over a debt of zero —
is the honest next criterion, and it waits for a baseline reading over
several trials before anyone pins it.

**The columns, and where each comes from (2026-09-10).** Before the score
became the baseline for the next surface change, its set was checked
against the graph-drawing and diagram-layout literature rather than
extended by taste. What that reading settled:

- The ranking that decides what is DEBT. Crossings matter more than any
  other aesthetic by a wide margin (Purchase, GD 1997, replicated for UML
  by Purchase et al. 2001 and Sun & Wong 2005), and after them what Ware
  et al. (Information Visualization, 2002) call continuity: a path that
  turns back on itself reads worse than one that merely bends. An edge's
  ink through a box it does not connect is a named metric, Dunne et al.'s
  "edge tunnel" (IBM J. Res. & Dev. 2015). A line through a frame that
  none of its ends belongs to is the one rule of c-planarity (Feng, Cohen
  & Eades, COCOON 1995). Flow is read from where boxes sit, not from each
  arrow's angle: position-based flow correlated with readers at r=0.72
  where angle-based scored 0.26 (Burattin et al., 2016), which is also
  the Sugiyama convention of upstream above downstream.
- Three debt columns added from that list: `edgeThroughFrame`,
  `edgeOverlaps` with `sharedInkPx` (two edges along one line, which no
  reader can tell apart — the orthogonal drawing's own defect, where
  straight-line drawings have angular resolution). Three price columns:
  `reversals` (continuity), `flow` with `againstFlow` (position-based
  flow, lateral arrows under the near-miss band counted as beside it, a
  tie broken in a fixed order), and per-size rates `crossingsPerEdge`,
  `bendsPerEdge`, `overlapsPerPair` so boards of different sizes compare
  — per edge as OGDF and ELK report, because Purchase's normalisation by
  a theoretical maximum has no meaning for a routed path.
- What was deliberately not added. Crossing angle and angular resolution:
  on orthogonal routes every crossing is a right angle and every fan is
  parallel, so both read 1.0 by construction (Mooney et al., PacificVis
  2024, say the same of HOLA). Node resolution: uninformative over 450k
  drawings in the same study. A single weighted score: the metric
  landscapes (Mooney 2024; Ahmed et al., TVCG 2022) found pairs that
  fight, and a 2025 preprint morphed drawings into a dinosaur while
  holding every standard metric steady — so the columns stay a vector,
  and the scoreboard pins a board scattered so far apart that no debt
  column can see it, as the known blind spot rather than a claim of
  completeness. An LLM judge for layout: the one study that measured it
  found judges insensitive to exactly these artefacts.
- What makes the instrument believable beyond calibration, now tested:
  each reference owes no more than its draft on any debt column and less
  in all; tidy never adds debt; and each planted defect moves the column
  that names it and no other debt column, over eleven planted cases. The
  mutation checks that established the calibration covered every new
  column: two mutations survived a first pass because two cases were too
  gentle (no edge with arrowheads at both ends; a lateral arrow on an
  exact row), and the cases were sharpened until they died.
- The first reading of the new columns is a router finding. The
  hand-drawn architecture REFERENCE owes three reversals: the router
  draws both same-row edges inside the Services frame as loops — down
  from the box's bottom, along, and back up — with no side pinned by
  anyone, the same picture the lane's `fromSide: 'bottom'` board showed.
  Pinned at 3 with the reason, so a change to the router's side choice
  for a same-row neighbour is judged by that number.

## Consequences

- A retirement is no longer argued from the count. Its PR carries the
  rung-1 diff (C1, C3), the rung-2 diff (C13) and a rung-3 before/after
  (C14), and a reviewer reads the three together — the price column
  exists so a consolidation cannot buy fewer calls with a bigger table
  silently.
- Rung 1's numbers are pinned exactly, so every description added and
  every schema reshaped fails the scoreboard until its row is re-pinned.
  That is the same discipline as the routing and search scoreboards, and
  the same cost: a line in the commit saying why.
- Rung 3 costs money and minutes, and is non-deterministic. One trial is
  a reading; a decision cites `--trials=3` and reports pass^k. A task
  that fails every trial on a frontier model is first suspected of being
  a broken task.
- The fixture and the tasks are held-out from the descriptions: a
  description may not quote a task, and a task may not name a tool.
  Refreshing the tasks when the descriptions are rewritten is part of
  the description increment.
- `apps/web` and the daemon's HTTP routes are untouched; this ADR judges
  the MCP tool table only.

## Alternatives considered

**A tool-count ceiling.** Rejected: no source that measured anything
measured the count, and the count cannot see the two largest debts found
here (one tool being 45% of the table; 299 undescribed parameters).

**Tokens rather than bytes for C1.** Rejected for now: a tokenizer makes
the number depend on which model reads it and adds a dependency to a
test that must stay hermetic. Bytes are exact, monotone in tokens for
this JSON, and the ~4:1 ratio is stated wherever a token figure is quoted.

**A description lint (the six-component smell rubric) as a gate.**
Rejected as a gate, kept as a hint: the one paper that measured it found
description fixes regress a sixth of cases, so C3 counts presence and
rung 3 judges quality.

**Grading rung 3 by expected tool sequence.** Rejected, per the sources:
a valid path the task author did not anticipate would fail. The sequence
is recorded as a diagnostic beside the verdict.

**An LLM judge for the write tasks.** Rejected: the store can be read
back exactly, and a judge would add variance to a question with a
deterministic answer.

**Deferred tool loading / a tool-search tool now.** Deferred to a
threshold (§5), because at this size it would add a discovery step to
every errand to save a table that fits.
