// The tool-surface scoreboard: what the tool TABLE costs a model to read,
// and how much of it explains itself (ADR-0031).
//
// `tool-call-count-quality.test.ts` prices an errand once a model has chosen
// a tool. This prices the choosing. Every definition below is in the model's
// context on every turn whether or not the turn uses it, and a parameter
// with no description is one the model guesses at. Both are read off a REAL
// McpServer's `tools/list` over an in-memory transport, so a number here is
// what a client receives rather than what a registration says; the
// behavioural rows call the tool the same way.
//
// The numbers are pinned EXACTLY. An improvement has to be as loud as a
// regression, because the point is that someone says why it moved.
//
// DEBT rows target zero: `undescribed`, `strays`. PRICE rows have no target
// and exist so a change cannot buy one with the other silently: a
// consolidation that folds three tools into one can halve the count and
// double `visibleBytes`, and the pair is what says which happened.
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { InMemoryVersionHistory } from '../../shared/test-utils/in-memory-version-history.js'
import {
  crossReferences,
  descriptionWords,
  type ListedTool,
  modelVisibleBytes,
  parameterCoverage,
  wireBytes,
} from '../../shared/test-utils/tool-surface-metrics.js'
import { InMemoryDocumentStore } from '../store/inmemory/in-memory-document-store.js'
import { registerDocumentTools } from './document-tools.js'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'
import { registerPairingLinkTool } from './pairing-link.js'

async function connect(): Promise<{ client: Client; tools: readonly ListedTool[] }> {
  const server = new McpServer({ name: 'whiteboard-surface', version: '0.0.0' })
  // Only `tools/list` is read here, which touches no seam: the version
  // history is the one seam a registration reaches at construction, and
  // the rest are stated absent rather than faked with no behaviour.
  registerDocumentTools(server, {
    documentStore: new InMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    versions: new InMemoryVersionHistory(),
  } as never)
  // Registered separately in index.ts, so registered separately here: the
  // scoreboard reads the whole table, not the document half of it.
  registerPairingLinkTool(server, undefined, undefined)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'surface', version: '0.0.0' })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  return { client, tools: tools as readonly ListedTool[] }
}

const firstText = (result: { content?: unknown }): string => {
  const content = result.content as { type?: string; text?: string }[] | undefined
  return content?.find((block) => block.type === 'text')?.text ?? ''
}

interface Row {
  /** name + description + input schema, as the Messages API sends a tool. */
  visibleBytes: number
  /** The whole `tools/list` entry, output schema and annotations included. */
  wireBytes: number
  descriptionWords: number
  /** Properties the input schema declares at any depth (union arms counted each). */
  parameters: number
  /** DEBT — of those, the ones with no description. */
  undescribed: number
  /**
   * DEBT — what a top-level key the schema does not declare gets:
   * `refused` (the error names it) or `stripped` (silently dropped, so a
   * typo'd optional parameter does nothing and the call looks like it
   * worked). `unreached` when the tool refuses before validating anything.
   */
  strays: 'refused' | 'stripped' | 'unreached'
  /** The other tools the description names — the "when to use" edges. */
  names: readonly string[]
}

/**
 * One row moved with ADR-0037 and it is worth naming, because a pinned number
 * that shifts silently is the thing this board exists to prevent.
 *
 * `wb_canvas_edit` lost two parameters: an edge's facets are written as
 * `facets` now rather than `x-whiteboard.facets` — one level shallower, and
 * one fewer key named after an interchange format on a table a model reads
 * every turn. It followed rather than being chosen: the edge patch IS the
 * stored proposal patch (ADR-0029), so the tool's input and the storage are
 * one schema, and keeping the old spelling on the input alone would mean a
 * wrapper pair that exists only to preserve it.
 *
 * The NODE side still spells `x-whiteboard`, because its input is deliberately
 * NOT the stored shape — a flat write schema that refuses a `kind: "embed"`
 * naming no document, by name. Converging the two is the follow-up ADR-0037
 * names, and it goes through ADR-0031's criteria as a tool-surface change of
 * its own rather than riding along inside a refactor.
 *
 * The wire-byte drops (~4KB across the table) are not a surface change at all:
 * the model and the format are two schema objects now where they used to be
 * one, so zod's JSON-Schema emitter inlines and $refs them differently.
 * `visibleBytes` moved by 9 bytes, which is what says so.
 *
 * A second, smaller move came with slice 4: a node's `x`/`y`/`width`/`height`
 * are `number` in the schema where they were `integer`, so every tool that
 * carries a node box got a little cheaper to read (-680 wire bytes across the
 * table, -16 visible on `wb_canvas_edit`). The parameter and undescribed
 * counts are unchanged, which is what says the surface a model READS is the
 * same set of fields saying the same things — only what they accept widened,
 * and it widened towards the model rather than away from it.
 *
 * The bends half of the same slice DOES move the surface, and deliberately.
 * An edge's `bends` is a field of the edge now rather than `visual.path/v0`,
 * so it reaches `wb_canvas_edit`'s edge add and patch the way every other
 * edge field does: +6 parameters (the list and its two coordinates, at both
 * sites), of which the list itself carries a description and the coordinates
 * do not — `x` and `y` on a point need no prose, and writing some would be
 * padding a table a model reads every turn.
 *
 * What it BUYS against those bytes is the reason a model could not place a
 * bend at all before: a facet payload is opaque to `wb_canvas_edit`, so the
 * only writer was `wb_facet_set` with a plugin's key and its own schema.
 */
describe('what the tool table costs to read', () => {
  it('scores every registered tool', async () => {
    const { client, tools } = await connect()
    expect(tools.map((tool) => tool.name).sort()).toEqual([...ALL_REGISTERED_TOOLS].sort())

    const rows: Record<string, Row> = {}
    for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      const coverage = parameterCoverage(tool.inputSchema)
      if (process.env.DUMP_PATHS !== undefined && tool.name === 'wb_canvas_edit') {
        // eslint-disable-next-line
        require('node:fs').writeFileSync(process.env.DUMP_PATHS, coverage.undescribed.join('\n'))
      }
      // An unknown key beside nothing else: a refusal that names it has
      // read it; one that lists only the missing fields has dropped it.
      const stray = await client.callTool({ name: tool.name, arguments: { zz_stray: true } })
      const strayText = firstText(stray)
      rows[tool.name] = {
        visibleBytes: modelVisibleBytes(tool),
        wireBytes: wireBytes(tool),
        descriptionWords: descriptionWords(tool),
        parameters: coverage.parameters,
        undescribed: coverage.parameters - coverage.described,
        strays: strayText.includes('zz_stray')
          ? 'refused'
          : strayText.startsWith('Input validation error')
            ? 'stripped'
            : 'unreached',
        names: crossReferences(tool),
      }
    }

    expect(rows).toEqual({
      // Every tool refuses a stray key since every registration hands the
      // SDK the Zod OBJECT rather than its `.shape` (ADR-0031 C10): handed
      // a shape, the SDK rebuilt a non-strict object around it, and a
      // misspelt optional parameter was dropped with the call reporting
      // success — 15 of 18 tools, and wb_facet_list, every parameter of
      // which is optional, answered the unfiltered list to any input at
      // all. The price is 29 visible bytes a tool (`"additionalProperties":
      // false`), 493 across the table.
      //
      // The MCP Apps UI tool. Nearly all of its wire size is an OUTPUT
      // schema (the whole scene), which the model never reads.
      //
      // -1,241 wire when `CanvasColor` / `CanvasPoint` / `NodeEmbed` /
      // `Bends` were named in zod's registry: a scene repeats all four, so
      // this row is where the registration pays most.
      canvas_view: {
        visibleBytes: 733,
        wireBytes: 20500,
        descriptionWords: 39,
        parameters: 3,
        undescribed: 3,
        strays: 'refused',
        names: [],
      },
      // +817 when the text anchor's fields were described: the lane's one
      // refusal on this tool was a model omitting `start`/`end`, and the
      // anchor is emitted here and in wb_thread_edit's anchor union. The
      // C3 case ADR-0031 §3b pays for: described because a model guessed,
      // not because a column said so.
      // Wire only, +6,664: the INPUT is untouched, and the output schema
      // carries a canvas. The endpoint union is paid by the client on
      // connect and by the model not at all — the split this scoreboard
      // keeps two columns for.
      wb_body_edit: {
        visibleBytes: 2663,
        // +1,396 wire, and it is the registration's PRICE rather than its
        // saving: a named subschema costs a `$defs` entry plus a `$ref`
        // wherever it is used, so a tool that uses one ONCE pays more than
        // inlining it. Recorded rather than smoothed over — the lever is
        // worth pulling on the table's total, and this row is what it costs
        // to pull.
        // -8 when `node.patch`'s geometry stopped restating `int`. ATTRIBUTED
        // by measurement, not by argument: reverted, this row reads 21956;
        // applied, 21948. The mechanism is NOT established — `body-edit.ts`
        // imports no node patch and no integer schema — so the number is
        // recorded and the cause is left open rather than invented.
        wireBytes: 21948,
        descriptionWords: 112,
        parameters: 18,
        undescribed: 7,
        strays: 'refused',
        names: [],
      },
      // 39% of everything the model reads, in one tool: the ops union
      // carries the full node and edge schemas once per arm, and not one
      // of its 207 properties says what it is for. -1,640 bytes when the
      // model's integers stopped emitting safe-integer bounds (sixty
      // `minimum: -9007199254740991, maximum: 9007199254740991` pairs on
      // one tool; `integerSchema` in packages/model).
      // -1,320 more when the node extension a WRITER sends became one
      // flat object narrowed on parse (nodeExtensionWriteSchema) instead of
      // the stored two-variant union inlined eight times.
      // -3,391 (26% of the tool, 10% of the table) when `region.set` stopped
      // carrying the node union a second time: it names members by id now,
      // and a member is created by `node.add` with `within` (+1 parameter,
      // described). The lane placed the change: on the errand the op was
      // built for, the old shape had a model writing x/y/width/height for
      // every box, the ones already there included (ADR-0031 §4).
      // +1,095 for a SELECTOR where an id goes — `within` (every node
      // inside a group) and `all` on patch, remove and lock, `within` on
      // tidy; eleven parameters, every one described. Placed by the lane:
      // "lock every item on the roadmap" went from three calls to two in
      // two trials of three (the snapshot that only learned the ids was
      // skipped), and "colour every box inside the Clients group" from two
      // ops to one; six trials of six reached for the selector unprompted.
      // +508 for `fromSide`/`toSide` described on the stored edge schema,
      // which edge.add and edge.patch each derive, so four parameters
      // gained a description at once. Described because the lane's
      // architecture board owed every one of its debts to a model writing
      // bottom/top on all eight edges, two of them between boxes on one
      // row (ADR-0031 §7): the sides now say what leaving them out buys.
      // +1,045 for `width`/`height` described on the stored node schema and
      // the patch: ten parameters, because node.add emits them per node
      // type. Described because the lane's long-sentence task named a
      // height too small for its text and the sentence was cut; the
      // description alone moved nothing (3 of 3 still cut), so a height too
      // short for its text is now refused with the number, and the
      // description says so.
      // +124 for `within` on node.add saying what a NEW group over boxes
      // that already exist takes (add it, then region.set): the lane's
      // wrap-a-chain trials wrote `within: null` or the group's own id on
      // the group and found region.set on a second call.
      // +104 for region.set saying a group added in the batch with no
      // position is placed around its members: with the sentence above
      // the trials wrote one batch, then two more calls undoing where the
      // cursor had put the group and the column it had pulled the row into.
      // +107 for `within` accepting null (models write it to say "no group",
      // and the refusal cost the whole call) and saying a group added in
      // the batch with no position is placed around what goes in it.
      // +480 visible bytes and +2 parameters for ADR-0034's `stencil`, one
      // on `node.add` and one on `node.patch`. C1 going UP is the cost this
      // row exists to make visible, so the trade is stated rather than
      // implied: the ids are a `z.enum` and the prose is one line, which
      // measured 480 against 776 for the same ids listed in prose and 356
      // for a description that lists none — and the third is cheapest
      // precisely because it leaves no way to learn the vocabulary.
      //
      // C13 does NOT pay for it. The errand scoreboard says dressing six
      // boxes is one call either way and 337 request bytes cheaper, which
      // is a saving per errand against a cost per turn. What the field buys
      // is on the facet-vocabulary axis, not this one: a board that declares
      // what its kinds are instead of spending a scheme invented per drawing.
      // 13466 -> 13502 swapping the stencil ENUM for a validated string that
      // points at `wb_facet_list`. Within 36 bytes of each other at the
      // bundled six — and only one of them scales. Measured: the enum costs
      // ~38 bytes per stencil per op, so 120 stencils reads +4838 here,
      // 13% of the whole table, on every turn, for a vocabulary most
      // conversations never touch. A library is meant to grow; a cost that
      // grows with it is the wrong shape, so discovery moved to a runtime
      // answer that costs nothing until asked.
      //
      // 13502 -> 13618 making a node DRAFT strict, which is the same 29
      // bytes per object the stray-key row above charges, times the four
      // node types the draft union carries. Bought a refusal where there
      // was SILENCE: `stencil` written inside `node` — the likelier guess,
      // since every other property of the box goes there — was stripped and
      // the box drawn undressed with nothing said, while the identical
      // mistake inside `patch` was already refused by name. Measured in a
      // lane trial that then spent seventeen calls recovering by hand.
      // -6 dropping `badge` from the stencil field's description: the
      // bundled set writes one, and a board draws none.
      //
      // Then the edge END became a discriminated union, and the endpoint is
      // NAMED in zod's global registry (`packages/model/src/spatial.ts`), so
      // it lands in `$defs` once and is referenced at each of its four sites
      // instead of being inlined four times.
      //
      // That naming is why this row reads +1,006 against main rather than
      // +3,799: inlined, the four sites are 4,579 bytes and the whole table
      // read 40,315 — over ADR-0031 §5's ~40,000. Referenced they are 1,786,
      // and every column below is better than the inline form on a strictly
      // richer schema. `parameters` and `undescribed` fall BELOW main's
      // (153/123) for the same reason: a subschema counted four times is now
      // counted once, so the endpoint's `kind` discriminators stop being
      // eight undescribed lines and become two.
      //
      // The saving is available only here, and that is worth knowing before
      // reaching for it again: the SDK converts by calling
      // `schema['~standard'].jsonSchema.input({ target })` and passes no
      // `reused` option, so `z.toJSONSchema(..., { reused: 'ref' })` never
      // reaches the published schema. A registry `id` does.
      //
      // +2,056 visible for ADR-0038 decision 2's three LINE ops (`line.add`,
      // `line.patch`, `line.remove`) — what lets anything but the editor
      // author ink. Inline they were +3,403 and the TABLE crossed 40,000;
      // naming the four subschemas the new arms made repeat gave 1,543 back.
      // `parameters` and `undescribed` rise with them, and the one
      // description bought is on `line.add`'s draft: when to reach for ink
      // over a relation, which is the only thing here a model cannot infer
      // from JSON Canvas.
      // TWO causes, and they must not be read as one.
      //
      // BYTES: -776, the node extension NAMED in zod's registry so it is
      // emitted into `$defs` once rather than inlined at each of its four
      // sites. Nothing about what a model may send changed.
      //
      // COUNTS: +56 parameters and +24 undescribed at UNCHANGED bytes, and
      // this is the instrument being corrected, not the surface moving. The
      // oracle did not resolve `$ref`, so every property inside the five
      // subschemas already named in the registry was invisible to it — the
      // debt this board reports was understated by 24 for as long as those
      // registrations have existed. It was wrong in both directions, which is
      // why it never looked wrong: registering an undescribed subschema read
      // as debt PAID and a described one as debt ADDED.
      //
      // Only a COMPOSITE is registered, and that rule is measured. A
      // description inside a registered object survives into `$defs`; a
      // description ON the registered schema is dropped. Registering the
      // described `width`/`height` leaves read as -837 bytes, and the bytes
      // WERE the descriptions being deleted (4 arms x (60 + 150)) — a saving
      // that is really a silent content loss, refused here.
      //
      // And -4 visible / -12 wire on top of both, from this branch:
      // `node.patch`'s geometry stopped restating `int` and now derives from
      // what a node STORES, which is a real number (ADR-0037 slice 4). The
      // table pays four bytes less for a schema that accepts strictly more —
      // the patch had been refusing the sub-pixel coordinates the editor
      // writes. Independent of the two causes above and additive to them,
      // measured rather than reasoned: the same -4/-12 appears against
      // main's new base as it did against the old one.
      wb_canvas_edit: {
        visibleBytes: 15043,
        wireBytes: 38013,
        descriptionWords: 169,
        parameters: 221,
        undescribed: 154,
        strays: 'refused',
        names: [],
      },
      // Wire only, +1,884: this tool's INPUT is three fields and its OUTPUT
      // carries edges, so the endpoint union costs the client on connect and
      // the model nothing on every turn. Same for `canvas_view` above.
      wb_canvas_snapshot: {
        visibleBytes: 705,
        // +1,303 wire: the snapshot answers with `lines` now. It did not,
        // which meant a model could write ink through `wb_canvas_edit` and
        // had no way to read it back — a write with no read is half a
        // capability, and the wire is where that costs.
        wireBytes: 5532,
        descriptionWords: 53,
        parameters: 3,
        undescribed: 3,
        strays: 'refused',
        names: ['wb_document_get'],
      },
      wb_document_get: {
        visibleBytes: 979,
        wireBytes: 2757,
        descriptionWords: 63,
        parameters: 4,
        undescribed: 3,
        strays: 'refused',
        names: [],
      },
      wb_document_list: {
        visibleBytes: 473,
        wireBytes: 1130,
        descriptionWords: 32,
        parameters: 1,
        undescribed: 1,
        strays: 'refused',
        names: [],
      },
      // Re-pinned when the filter learned to stand alone (ADR-0031 §4):
      // `query` is optional now, and +379 visible bytes say so on the
      // parameter and in the description, with the last two undescribed
      // parameters described. Rung 3 on "count the tagged documents", three
      // trials: 3 calls each before (a search that answered nothing, then
      // a list and a read of every document), 1 after.
      wb_document_search: {
        visibleBytes: 1410,
        wireBytes: 2240,
        descriptionWords: 68,
        parameters: 5,
        undescribed: 0,
        strays: 'refused',
        names: [],
      },
      // +224 for the registered ASSETS (ADR-0034 decision 4): the stencil,
      // theme and icon ids a deployment registered, with an `assetKind`
      // filter. This tool already existed to answer "what did this
      // deployment register", so the ecosystem's discovery reuses a seam
      // instead of adding a tool or growing `wb_canvas_edit`'s schema —
      // where the same information would have cost 13% of the table at a
      // hundred-icon pack.
      //
      // `undescribed` stays 1: the new parameter carries its own
      // `.describe()`, because C3 counts down and never up.
      //
      // +274 visible bytes again for `workspaceId` (足場4b), and this row is
      // the one place the trade is stated. C1 goes UP, which for an addition
      // is the only direction it can go; what it buys is C5 — an errand step
      // that had no tool behind it at all. A workspace's stencil library is
      // CONTENT, so no registry a deployment composes can see it, and the
      // ids it defines were reachable only by opening the library document
      // and reading its frontmatter. The how-to shipped that as a stated
      // limit one increment ago; this retires it.
      //
      // The cost is paid ONCE, in the table, and never per stencil: the ids
      // stay out of every schema for the reason the assets half of this
      // tool exists (+4838 to `wb_canvas_edit` at 120 stencils). A library
      // that grows to a hundred adds nothing to what a model reads.
      //
      // +142 WIRE bytes and ZERO visible for `assetRefs` — which of a
      // facet's fields takes a registered asset id, and of what kind. It
      // lands in the OUTPUT schema, so C1, the budget a model pays on every
      // turn, does not move at all; that asymmetry is the point of putting
      // the join here rather than in a description.
      //
      // What it buys is C5. The answer already carried both halves of a
      // join and not the join: `facets` publishes `visual.stencil/v0` as a
      // pattern-checked string, `assets` publishes the stencil ids, and
      // nothing said the first is where the second goes. Round 13 measured
      // the consequence — a model asked this tool for `assetKind:
      // 'stencils'`, the right question, then wrote `visual.shape/v0` with
      // `{kind: 'diamond'}`: a registered facet, a successful write, and a
      // silhouette rather than a kind. The shape facet publishes an enum
      // holding the word it wanted; the stencil facet published a regex. It
      // acted on the one it could act on.
      //
      // The preceding attempt at the same defect spent 133 VISIBLE bytes on
      // a sentence in `wb_canvas_edit` and was withdrawn on its own reading
      // (branch `kind-sentence`): the sentence was followed, to this same
      // wrong facet. A join the answer carries is not a sentence a model
      // may or may not act on.
      // +75 visible to describe `target`, the tool's last undescribed
      // parameter — C3 paid, and NOT a steer.
      //
      // The steer was tried and REFUTED, which is why this number is 75 and
      // not 221. The rung-3 lane had caught this parameter hiding a whole
      // scope: asked for a board where what a box IS and whether it is
      // HEALTHY both had to read at a glance, three trials of three filtered
      // to `node` — right for dressing boxes — and so never saw that a
      // board-wide scope exists, colouring by health and recording nothing
      // (ADR-0033's `contested`). A clause saying so was added and measured
      // over three more trials: the model filtered to `node` in all three
      // again, and the reading stayed 0 of 3. The clause was withdrawn and
      // the plain meaning kept (ADR-0031's fourteenth reading).
      //
      // That is now twice on this tool's subject, and the entry above says
      // what both point at: a join the ANSWER carries is not a sentence a
      // model may or may not act on.
      wb_facet_list: {
        visibleBytes: 1002,
        wireBytes: 2114,
        descriptionWords: 63,
        parameters: 3,
        undescribed: 0,
        strays: 'refused',
        names: [],
      },
      // Re-pinned when the tool learned to tag (ADR-0031 §4): +1,122
      // visible bytes buy `tags.add` / `tags.remove` — three parameters, all
      // described, and the four that were not now are — and a description
      // that says "tags", which three trials of "tag this note" had never
      // once been able to act on. Rung 3 on that task: 5.7 calls and 7 tool
      // errors over three trials before, 2 calls and 0 after.
      wb_facet_set: {
        visibleBytes: 2421,
        wireBytes: 3240,
        descriptionWords: 118,
        parameters: 9,
        undescribed: 1,
        strays: 'refused',
        names: ['wb_facet_list'],
      },
      // Moved down when the link stopped carrying a credential: the
      // description's SECURITY warning ("this URL embeds the daemon
      // bootstrap token — treat it like a credential") described something
      // that no longer exists, and the output schema's `authMode` and
      // `expiresHint` described the same vanished token. 1257 -> 994
      // visible bytes (-263, -21%) and 70 -> 35 description words, for a
      // tool whose input schema did not change at all.
      wb_pairing_link_create: {
        visibleBytes: 994,
        wireBytes: 1442,
        descriptionWords: 35,
        parameters: 4,
        undescribed: 0,
        strays: 'refused',
        names: [],
      },
      wb_scene_render: {
        visibleBytes: 2221,
        wireBytes: 2568,
        descriptionWords: 51,
        parameters: 5,
        undescribed: 2,
        strays: 'refused',
        names: [],
      },
      wb_thread_edit: {
        visibleBytes: 3375,
        wireBytes: 3942,
        descriptionWords: 122,
        parameters: 32,
        undescribed: 25,
        strays: 'refused',
        names: [],
      },
      // The version tools, the pairing tool and now wb_facet_set are the
      // ones whose every parameter is described. They are the shape to copy.
      wb_version_list: {
        visibleBytes: 604,
        wireBytes: 1535,
        descriptionWords: 20,
        parameters: 2,
        undescribed: 0,
        strays: 'refused',
        names: [],
      },
      wb_version_restore: {
        visibleBytes: 1504,
        wireBytes: 2156,
        descriptionWords: 41,
        parameters: 6,
        undescribed: 0,
        strays: 'refused',
        names: [],
      },
      wb_version_save: {
        visibleBytes: 982,
        wireBytes: 2052,
        descriptionWords: 54,
        parameters: 3,
        undescribed: 0,
        strays: 'refused',
        names: ['wb_version_restore'],
      },
      wb_viewport_set: {
        visibleBytes: 900,
        wireBytes: 1298,
        descriptionWords: 52,
        parameters: 8,
        undescribed: 8,
        strays: 'refused',
        names: ['wb_canvas_edit'],
      },
      wb_workspace_edit: {
        visibleBytes: 2287,
        wireBytes: 3252,
        descriptionWords: 44,
        parameters: 18,
        undescribed: 14,
        strays: 'refused',
        names: [],
      },
    } satisfies Record<(typeof ALL_REGISTERED_TOOLS)[number], Row>)
  })

  it('totals: what the whole table costs, and how much of it is unexplained', async () => {
    const { tools } = await connect()
    const total = (pick: (tool: ListedTool) => number) => tools.reduce((n, t) => n + pick(t), 0)
    expect({
      tools: tools.length,
      // PRICE. ~8.7k tokens at four bytes a token, on every turn of every
      // conversation that has this server attached — under the ~10k tokens
      // at which Anthropic's own guidance says to stop loading a table
      // upfront and search it instead, and one tool is 45% of it.
      visibleBytes: total(modelVisibleBytes),
      // PRICE, paid by the client on connect rather than by the model:
      // two-thirds of it is output schemas.
      wireBytes: total(wireBytes),
      // DEBT. 327 declared, 32 described: wb_facet_set's seven were the
      // first tool paid down (+3 declared, all described).
      parameters: total((t) => parameterCoverage(t.inputSchema).parameters),
      undescribed: total((t) => {
        const c = parameterCoverage(t.inputSchema)
        return c.parameters - c.described
      }),
    }).toEqual({
      // 17: wb_document_resolve retired (ADR-0031 §4) — its one answer, an
      // id's path, is a column of every wb_document_list row, so the table
      // lost 442 bytes and no errand lost a way to be done. Rung 3 after:
      // see the ADR's baseline.
      tools: 17,
      // +1,122 for wb_facet_set's tags (see its row), +464 for every tool
      // refusing a stray key (see canvas_view; sixteen tools, the two that
      // already registered the object unchanged), +379 for a search filter
      // that stands alone (see wb_document_search). Under the ~40,000 at
      // which ADR-0031 §5 says to reconsider loading the table upfront.
      // -1,912 when the model's integer fields stopped emitting safe-integer
      // bounds (see wb_canvas_edit): the first cut that took nothing away
      // from what a model can do.
      // -1,320 for wb_canvas_edit's flat write-side extension; +1,366 for
      // the text anchor and the body change described (see wb_body_edit).
      // -3,391 for region.set naming members by id (see wb_canvas_edit):
      // 31,394 is the first reading under 32,000 since the table was
      // first pinned at 34,960.
      // +1,095 for selectors where an id goes (see wb_canvas_edit).
      // +940 when the render theme layer landed on main (ADR-0030): `style`
      // on canvas_view and wb_scene_render, `target` on wb_facet_set; the
      // two new undescribed parameters are that layer's, not this sweep's.
      // +508 for the two edge sides described where the stored schema
      // declares them (see wb_canvas_edit); the wire moves on every tool
      // whose output carries an edge.
      // +1,045 for the box sizes described where the stored schema declares
      // them (see wb_canvas_edit); wire moves on every tool whose output
      // carries a node.
      // +124 for `within` on node.add (see wb_canvas_edit).
      // +516 for `stencil` on node.add and node.patch plus the registered
      // assets on wb_facet_list — the two halves of one decision, since the
      // field is a plain string precisely because the list lives there.
      // +116 for a strict node draft on node.add (see wb_canvas_edit): four
      // node types x the 29 bytes a strict object costs, for a stray key
      // refused instead of silently dropped, less 6 for a `badge` the
      // stencil field's description no longer promises (see wb_canvas_edit).
      //
      // Then +1,006 when an edge END became a discriminated union NAMED in
      // zod's global registry, so it is emitted into `$defs` once and
      // referenced at each of its four sites (`from` and `to`, on `edge.add`
      // and on `edge.patch`).
      //
      // The naming is the whole reason this sits under ADR-0031 §5's ~40,000
      // rather than over it. Inlined — zod's default, and what the SDK's
      // conversion path gives you unless a schema is registered — the four
      // sites are 4,579 bytes against 1,786 referenced, and the table read
      // 40,315: the first reading ever to cross that line. The 2,793 is what
      // this row gives back, and it is why the `workspaceId` below and any
      // next addition have room rather than a decision to make.
      //
      // Measured against `origin/main` rather than inferred: `wb_canvas_edit`
      // is the ONLY row whose visible bytes move, and inline it was +3,799 of
      // which the endpoint union was +3,440 — the growth was DUPLICATION, not
      // expressiveness, and duplication is the one kind of growth a schema
      // can give back without giving anything up.
      // +274 for `workspaceId` on wb_facet_list (足場4b): the one parameter
      // that makes a WORKSPACE's own stencil vocabulary discoverable, paid
      // once in the table and never per stencil.
      //
      // Then +2,056 on `wb_canvas_edit` for ADR-0038 decision 2's LINE ops —
      // `line.add`, `line.patch` and `line.remove`, which are what let
      // anything but the editor author ink. The model had held a line since
      // the split and no tool could make one; the smoke asserted that gap
      // rather than pretending it away.
      //
      // Inline it was +3,403 and the table read 40,348 — over ADR-0031 §5's
      // ~40,000 for the second time in this branch's life. What gave 1,543 of
      // it back is the same lever as last time, applied to what the new arms
      // made repeat: `Bends` (four sites now, and its two SOURCE declarations
      // were identical), `CanvasColor` (nine), `NodeEmbed` (four) and
      // `CanvasPoint` (four) are named in zod's global registry, so each is
      // emitted into `$defs` once. Measured per subschema before choosing
      // them, by waste (occurrences-1 x bytes) rather than by size.
      //
      // The debt columns rise and that is not disguised: `parameters` 273 ->
      // 289 and `undescribed` 185 -> 198 are the new element's own fields.
      // One description was bought deliberately, on `line.add`'s draft, and
      // it is the only one a model cannot infer from JSON Canvas: WHEN to
      // reach for ink over a relation (C4). The rest are `id`, `color`,
      // `label` and `facets`, which mean on a line exactly what they already
      // mean on an edge.
      // 39,001 -> 38,997: `node.patch`'s geometry derived rather than
      // restated (see `wb_canvas_edit` above). Strictly more accepted, four
      // bytes cheaper.
      //
      //
      // Then +142 on the WIRE alone, and nothing else: `assetRefs` on
      // `wb_facet_list`'s answer, plus `visual.axes/v0` and a sixth
      // silhouette (ADR-0036). `visibleBytes`, `parameters` and
      // `undescribed` do not move at all, which is the whole shape of that
      // work — a facet reaches `wb_facet_set` as a generic record, so
      // declaring a semantic axis or a new silhouette costs a model
      // nothing on the table it reads every turn.
      //
      // Then +75 to describe `wb_facet_list`'s `target` (see its row): C3
      // falls 198 -> 197 for 75 bytes, which is the whole trade once the
      // steering clause that would have cost 221 was measured and withdrawn.
      // The rung-3 task it was aimed at reads 0 of 3 before and after, so
      // this row buys the debt and nothing else — said plainly, because a
      // re-pinned row with no reason is the regression the exact pin refuses.
      //
      // Then -776 for the node extension named in zod's registry (see the
      // canvas_edit row), and separately +56 parameters / +24 undescribed at
      // unchanged bytes when the oracle learned to resolve `$ref`. The second
      // pair is the instrument, not the table: 345 and 221 are what the
      // surface has been all along, and 289 / 197 were what an oracle that
      // stopped at a `$ref` could see of it.
      //
      // Then -4 visible / -20 wire for `node.patch`'s derived geometry (see
      // the `wb_canvas_edit` row). Strictly more accepted, and cheaper.
      visibleBytes: 38296,
      wireBytes: 115719,
      parameters: 345,
      undescribed: 221,
    })
  })

  // C10, held as a statement rather than only as eighteen pinned rows: a
  // tool that starts stripping again fails here by name.
  it('every tool refuses an unknown top-level key by name', async () => {
    const { client, tools } = await connect()
    for (const tool of tools) {
      const result = await client.callTool({ name: tool.name, arguments: { zz_stray: true } })
      expect(result.isError, tool.name).toBe(true)
      expect(firstText(result), tool.name).toContain('zz_stray')
    }
  })

  // MCP 2025-11-25 (SEP-1303): an input the schema rejects is answered as a
  // TOOL error the model can read and repair from, never as a JSON-RPC
  // protocol error that ends the turn. Held for every tool rather than
  // sampled, because the registration helper is what decides it and a tool
  // registered around the helper would be the one that regresses.
  it('every tool answers an empty call with a tool error that names the missing field', async () => {
    const { client, tools } = await connect()
    for (const tool of tools) {
      const required = tool.inputSchema.required ?? []
      // A tool with nothing required (wb_facet_list) answers an empty call
      // rather than refusing it, and has no field to name.
      if (required.length === 0) continue
      const result = await client.callTool({ name: tool.name, arguments: {} })
      expect(result.isError, tool.name).toBe(true)
      const text = firstText(result)
      // wb_pairing_link_create refuses for want of a daemon before it
      // validates; that refusal is a tool error too, but names no field.
      if (text.startsWith('Input validation error')) {
        expect(text, tool.name).toContain(required[0])
      }
    }
  })
})
