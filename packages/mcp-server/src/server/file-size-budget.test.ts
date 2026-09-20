import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// docs/contributing/review-checklist.md says "Files stay under 800 lines",
// and until this guard existed nothing enforced it — 17 files already over
// the line, none of them flagged, while every other architecture invariant
// in this repo has an executable guard (ADAPTERS_REACHING_MECHANICS,
// KNOWN_IMPORT_CYCLES). This is the same shape: a SHRINK-ONLY grandfather
// list, guarded from both sides, so an entry cannot outlive the debt it
// names. An over-800 file not in the list fails naming the file and its
// count; a listed file that has shrunk to 800 or under fails telling the
// closer to delete the entry — so paying debt off is recorded, not just
// tolerated silently forever.
//
// Deliberately NOT covered: the checklist's companion "functions stay under
// 50 lines" clause. That needs an AST to find function boundaries, which is
// a different instrument than counting a file's newlines — out of scope for
// this slice.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

const LINE_BUDGET = 800

/** `wc -l` semantics: the number of '\n' characters, not `split('\n').length`. */
function lineCount(absolutePath: string): number {
  const text = readFileSync(absolutePath, 'utf8')
  return (text.match(/\n/g) ?? []).length
}

/** The `src` directory of every package/tool matching a `<group>/*` glob that has one. */
function groupSrcDirs(group: string): string[] {
  return readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(group, entry.name, 'src'))
    .filter((relDir) => existsSync(join(REPO_ROOT, relDir)))
}

const SCAN_ROOTS = ['apps/web/src', ...groupSrcDirs('packages'), ...groupSrcDirs('tools')]

/**
 * Directories excluded WHOLE, with the reason a line count there would be
 * noise rather than debt.
 *
 * `migrations/` is history — a migration's own text does not change once
 * written (see .claude/rules/vocabulary.md). `vendor/budoux/` is a vendored
 * third-party file (`ja-model.ts`, a generated data table copied from the
 * `budoux` package — see its own README for why it is vendored rather than
 * depended on); its size is not this repo's code to shrink.
 */
const EXCLUDED_DIR_SEGMENTS = ['/migrations/', '/vendor/budoux/']

function walk(absoluteDir: string): string[] {
  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(absoluteDir, entry.name)
    if (entry.isDirectory()) return walk(absolutePath)
    return [absolutePath]
  })
}

function isScannedSourceFile(absolutePath: string): boolean {
  if (!/\.tsx?$/.test(absolutePath)) return false
  if (absolutePath.endsWith('.d.ts')) return false
  // Test files are held by TEST_FILE_SIZE_GRANDFATHER below, at the SAME
  // budget, so they are moved to a sibling ledger rather than exempted. This
  // line was a silent exclusion for a long time, unlike the two directory
  // exclusions above that each say why.
  if (isTestFile(absolutePath)) return false
  const normalized = absolutePath.replaceAll('\\', '/')
  return !EXCLUDED_DIR_SEGMENTS.some((segment) => normalized.includes(segment))
}

function isTestFile(absolutePath: string): boolean {
  return /\.test\.tsx?$/.test(absolutePath)
}

function isScannedTestFile(absolutePath: string): boolean {
  if (!isTestFile(absolutePath)) return false
  const normalized = absolutePath.replaceAll('\\', '/')
  return !EXCLUDED_DIR_SEGMENTS.some((segment) => normalized.includes(segment))
}

function scanTestFiles(): string[] {
  return SCAN_ROOTS.flatMap((relRoot) => walk(join(REPO_ROOT, relRoot)))
    .filter(isScannedTestFile)
    .map((absolutePath) => relativeToRepo(absolutePath))
    .sort()
}

function scanFiles(): string[] {
  return SCAN_ROOTS.flatMap((relRoot) => walk(join(REPO_ROOT, relRoot)))
    .filter(isScannedSourceFile)
    .map((absolutePath) => relativeToRepo(absolutePath))
    .sort()
}

/**
 * The repo-relative path in the form BOTH ledgers are keyed with.
 *
 * Normalised because the ledgers hold forward slashes and `join` produces
 * backslashes on Windows, where an unnormalised key matches nothing — so
 * every listed file would be reported as unlisted, which reads as the guard
 * finding real debt. The two filters above already normalise for the same
 * reason; this helper did not, and served both ledgers.
 */
function relativeToRepo(absolutePath: string): string {
  return absolutePath.slice(REPO_ROOT.length + 1).replaceAll('\\', '/')
}

/**
 * Files over the 800-line budget, each entry a CEILING the file must stay
 * at or under — not merely a membership list. The first version recorded a
 * count nothing compared against, and 11 of 17 files grew by up to 262
 * lines under a green build; the ratchet assertion below is what makes
 * "shrink-only" a property instead of a hope. Growing a listed file means
 * raising its ceiling here, on the record, in the same diff.
 *
 * Both-sides guarded below: an over-budget file missing from this list fails
 * the build, and an entry that no longer names an over-budget file fails it
 * too — the same contract as ADAPTERS_REACHING_MECHANICS and
 * KNOWN_IMPORT_CYCLES in tools/arch-lint/src/architecture-map.ts. Shrinking
 * one of these is a welcome diff; leaving its entry behind after shrinking
 * it is not.
 */
const FILE_SIZE_GRANDFATHER: Record<string, number> = {
  // +34 for `decide-proposal` (ADR-0029 decision 4): the union arm with the
  // reason its changes travel with the command, and a two-line fold over
  // `applyCanvasChange` — what adopting MEANS lives in model, not here.
  // +35 for `set-canvas-facet`: the union arm, and `withCanvasFacet` — the
  // one place the canonical-emptiness rule for a canvas envelope lives, so
  // a canvas that chose a setting and reverted serializes like one that
  // never touched it. `withEdgeStyle` now delegates to it rather than
  // repeating that rule, which is why the arm costs less than it reads.
  // +34 for the edge target: `set-edge-facet` writes a plugin-owned payload
  // to ONE edge, the twin of `set-node-facet`.
  // +17: `set-edge-bends`, the bend drag's write. Not a facet write since
  // ADR-0037 slice 4 — bends are a field of the edge, so the command carries
  // a value rather than an opaque plugin payload.
  // +18 when an edge END became a discriminated union (ADR-0037 slice 3):
  // `set-edge-ends` and `set-edge-side` write INSIDE the endpoint now, and
  // `set-edge-side` grew a real branch — only a node end has a side to pin,
  // so the write is a no-op on a free one. The width is the branch, not
  // ceremony: the flat version could not have had it.
  // +64 for INK: `create-line` and `delete-line`, `deleteInkCommand`, and the
  // `delete-node` cascade learning that a line whose end names the deleted
  // node goes with it. A line is a different collection from an edge, not a
  // variant of one (ADR-0038 decision 2), so the arms cannot share an edge's
  // — and `deleteInkCommand` exists precisely so the two collections are
  // reconciled HERE rather than at each of the call sites that hold one
  // selected-ink id. Roughly half the width is the comment saying why the
  // editor needs no second selection state: the scene already hands an edge
  // and a line out identically, which is the non-obvious fact that kept the
  // rest of this change small.
  // +35 for ADR-0040's tag writes: three union arms (`set-node-tags`,
  // `set-edge-tags`, `set-canvas-tags`) and their cases, each a whole-list
  // write through `lib/spatial/tags.ts`'s `withTagList`, where the set and
  // canonical-emptiness rules live rather than here.
  // 1099 + 66 when the two branches met: ADR-0040's three tag arms and
  // ADR-0038's two ink arms are independent additions to the same union,
  // and neither shrank on the merge.
  // Raised 1165 -> 1197 for `ungroup-ink`: breaking a handwritten mark
  // apart, which is the escape the automatic grouping owes its user.
  // Raised 1197 -> 1297 for `move-line` and `set-line-color`, the two
  // cheapest of the seven gaps `element-verb-parity.test.ts` reported on its
  // first reading: a `CanvasLine` stored seven things a person could want
  // changed and the editor wrote none of them. Two union arms, `updateLine`
  // (the `updateNode` sibling both need), the two writes, and
  // `moveInkCommand` — `deleteInkCommand`'s twin, and the one place that
  // looks at which collection a selected ink id came from.
  // Raised 1297 -> 1338 for the clipboard carrying ink: `ownedLinePoints`
  // (what a stroke occupies, with three readers now), `shiftLine` (the one
  // producer both the move and the paste offset go through), and the
  // fragment insert reading both collections for its bounds.
  // Raised 1338 -> 1498 as ink gained the rest of its verbs: `set-line-bends`,
  // `set-line-label`, the generic `set-line-facet`, `set-line-ends` and
  // `set-line-side`, plus `bendInkCommand` and `labelInkCommand` joining the
  // id-picking family. Every one of them is a cell
  // `element-verb-parity.test.ts` reported on its first reading, and with
  // them its `lines` column is empty.
  // Raised 1498 -> 1629 for the `attach` verb: `set-edge-end`,
  // `set-line-end`, the `EndTarget` both take, the `otherEndNode` self-loop
  // guard they share, and `endInkCommand` joining the id-picking family. It
  // is the first verb the matrix reported missing from BOTH collections
  // rather than from one, which is why one increment adds two writes.
  'apps/web/src/lib/spatial/commands.ts': 1629,
  // The annotation entry's scope resolver lives in `annotation-scope.ts`
  // rather than here, so what this file spends on it is the hook call — now
  // five lines because the entry also has to know the document's threads,
  // to open the one a paragraph already has. The two document pages paid
  // more than that back in the same change (942 -> 934, 926 -> 925), their
  // hand-built thread writes replaced by one shared door.
  // +1: the annotation entry also has to be handed the LIVE passage marks,
  // so the toolbar resolves a thread the way the gutter beside it does.
  // +25: the preview marker now says how many messages its conversation
  // holds — a count in the marker's state, a lookup beside the placement
  // that produces it, and a corner badge with the reasoning for why it
  // appears only past one. Read mode never shows the source, so this marker
  // is the whole of what a reader there has to judge a conversation by.
  // +20: the preview marker's origin is asked for through one
  // `previewDocumentSvg` instead of four bare `querySelector('svg')` calls,
  // and the definition carries why — inside the preview column that query
  // answers with a comment MARKER's own icon, so the placement was reading
  // its own previous output.
  // +7: the preview marker carries the conversation's STATUS. It said
  // nothing about resolved before, so a closed conversation's marker was
  // drawn exactly like an open one — and with the state present the marker
  // crosses to it rather than staying put.
  // +64: the proposal layer's in-place surface (ADR-0029 decision 1, for
  // prose) — two props with the doc comments that say what they are for,
  // and the card render. The cohesive half is already out: everything with
  // a seam (the open passage, its extension, the projection effect, where
  // the passage currently sits) is `use-passage-proposals.ts`, and what is
  // left is the component's own prop surface and one conditional render.
  // +3 for `completionOnDelete`: an import, the call, and one line saying
  // why. Raised rather than paid for by trimming prose — this file funded
  // an earlier increment that way, and a budget met by deleting rationale
  // buys lines at the price of the thing the lines were for.
  // +3 for nothing anyone wrote: renaming `emojiCompletionSource` to
  // `shortcodeCompletionSource` (it serves both vocabularies now) made the
  // `override` array one character too long for the line, and the formatter
  // broke it across three. Recorded rather than fought, and NOT paid for by
  // trimming prose, for the reason the entry above already gives.
  // +3 for `addToOptions`, which draws an icon row's glyph where an emoji
  // row shows its character. It has to be passed at each host's own
  // `autocompletion()` call — `completionConfig` is not exported, so it
  // cannot ride the shared theme, and a second `autocompletion()` beside
  // this one would replace its `override`.
  'apps/web/src/components/markdown-editor/MarkdownEditor.tsx': 1146,
  // +1: `CONTENT_CONTAINER_KEYS` gains the proposal layer's plane
  // (ADR-0029). One line, and it has to be here — the list is what a
  // tree-node host pre-attaches from, and a container attached on first
  // READ instead clears the UndoManager's redo stack.
  // +9: `writeSpatialCanvas` and `writeMarkdownBody` each split into a
  // committing wrapper over a non-committing `*Into`, so `withDocumentBatch`
  // can fold a whole act into ONE commit. The bodies did not grow; these are
  // the two wrappers and the two lines saying what the split is for.
  // +8: `commentToFields` refuses a comment naming both a node and an edge,
  // the same loud refusal it already gives a non-finite anchor and for the
  // same reason — the thread it becomes is one every reader would drop.
  // +1: an edge's `x-whiteboard` facets bucket crosses the bridge the way a
  // node's already did, so a per-edge facet survives a round trip.
  // +3: an edge's `bends`, written as one value — the round-trip property
  // reported it dropped before the line existed.
  // +6 for the comment on `edgeToFields` saying WHY an endpoint is stored as
  // one value: it is one thing with one meaning, so last-writer-wins per key
  // is the whole merge story, and two peers re-attaching the same end
  // converge on an end one of them chose rather than on a half of each.
  // +21: ADR-0038 decision 3's read-side lift (`liftLegacyNodeKind` plus the
  // `liftStoredNode` that composes it with the ADR-0037 one). Load-bearing,
  // and the comment is most of the lines: the model is `.strict()`, so a node
  // stored under the node-kind union fails its schema and the read drops what
  // fails — the node VANISHES rather than losing its content. Net of the
  // switch `nodeToFields` no longer needs.
  // +22 on the merge: a node's stored fields are written once as a
  // resource (ADR-0038 decision 3) beside the tag write ADR-0040 added,
  // and the kind switch the resource replaced was the shorter of the two.
  'packages/loro-adapter/src/loro-bridge.ts': 1126,
  'packages/canvas-render/src/layout/edges/edge-rules.ts': 948,
  // Shrunk from 973: the effect that fetches a theme's family from the
  // daemon became `hooks/useDaemonThemeFonts.ts`, which is where a
  // daemon-keyed effect belongs — App composes, it does not fetch.
  // Raised deliberately, +24, when the `#wb=` pairing link stopped carrying
  // the daemon's bearer token: the link became an INTENT App has to resolve
  // through the pairing grant, which is a responsibility the root did not
  // have before. Three modules were extracted rather than inlined for it
  // (lib/link-pairing.ts, hooks/useLinkPairing.ts,
  // components/LinkPairingPending.tsx) and two dead locals deleted; what is
  // left is the wiring itself, and shaving it further would be shuffling
  // lines to satisfy a number.
  // Raised 986 -> 988, +2, for the Settings /settings branch passing
  // `workspaceId` (from `daemonView.workspace`) to SettingsPage so its
  // Members card knows which workspace to manage (ADR-0041 S0-5).
  'apps/web/src/App.tsx': 988,
  // Raised 1196 -> 1245, +49, for naming the column area's four views. The
  // file GREW and says more for it: a four-arm ternary chain over three
  // unrelated tests became a discriminated union built once and a switch
  // that draws it, so the narrowing every later arm depended on — `documents`
  // is non-null — is stated in the type instead of implied by position.
  // Raised 1245 -> 1258, +13, for `refreshAndSelect`. The five call sites
  // that each re-read the list and re-selected a row lost three lines apiece
  // (-15), and the one definition plus the paragraph saying which five flows
  // it serves cost more than that. A net +13 to delete a rule that had to be
  // remembered in five places is the trade, said plainly rather than hidden
  // behind a smaller number.
  'apps/web/src/components/workspace-files/WorkspaceFilesPanel.tsx': 1258,
  // Raised from 1032 by the document PLANE primitives — a mergeable child
  // map on a document's node, and the read that never opens one. They sit
  // here rather than in a new file because `nodeById` is this module's, and
  // because a plane is a tree-node concept: splitting it out would export
  // the node lookup for one caller. The prose is most of the 44 lines and is
  // the point of them — a plane opened the regular way loses one replica's
  // whole plane with both sides agreeing on the survivor.
  // Raised again from 1076 by PLANE NAMESPACING — the `plane:` prefix, and
  // the two readers that now skip it. Nearly all of it is the reason: a
  // plane in the node's flat namespace is carried into
  // `projectWorkspaceDocument` and written back by the next content save,
  // from whatever the projection held when it was taken. Measured through
  // the daemon's merge before the fix, a branch tip read back as "" with
  // nothing red, which is precisely the comment's job to prevent a second
  // time.
  // 1144: `syncMapEntries`, so a fold or projection carries a nested
  // container (a thread, a proposal) instead of flattening it to a value.
  // 1165: the fold recreates a nested text or list container instead of
  // handing it to `LoroMap.set`.
  'packages/loro-adapter/src/workspace-tree.ts': 1165,
  // Raised from 1366 by the automatic-checkpoint trigger: a narrow
  // `{signal, flush}` pair on SessionDeps, signalled from
  // `subscribeLocalUpdates` and flushed from the two page-leaving handlers
  // beside the edit flush. Most of the 25 lines is the reason the FLUSH lives
  // here rather than as the page's own listener — its order against the edit
  // flush is load-bearing, and two independent listeners would leave that to
  // registration timing.
  // +70 for the proposal plane: the publish channel beside annotations, and
  // the two-plane write a decision is — statuses where the proposal lives,
  // plus the canvas when it was adopted.
  // +10: adopting a proposed passage writes the BODY, not only the status
  // (ADR-0029 decision 6). The write itself is `apply-adopted-passages.ts`;
  // these ten lines are its import, its call, and the comment saying why a
  // decision has to reach two planes here.
  // +4: the decide-proposal arm moved inside `withDocumentBatch`, so its
  // three subjects land as one delta and one undo step instead of four.
  // +18 for `getFacets`: a markdown document's own mark is a facet, which is
  // no canvas value, so a page reading only the canvas cannot see one. One
  // session serves both document pages, which is what keeps the two keepers
  // from drifting on it — and most of the eighteen lines say that.
  'apps/web/src/lib/document-sync-session.ts': 1493,
  // Raised from 1131 because compaction's retained-history cut now reads
  // branch tips from BOTH planes for the length of the migration: the record,
  // where a document goes the first time its branches are written, and the
  // rows a document that has not been written since still has. A union rather
  // than a merge — a document is never in both — and the comment saying so is
  // most of the 14 lines.
  'packages/mcp-server/src/server/store/document-store.ts': 1145,
  // Raised from 926 by the version STORE being built once and shared. A
  // merge's pre-merge point cannot go through the versions seam — that
  // `save` carries a label and nothing else, while a checkpoint has to say
  // it is automatic and which variation it belongs to — so the store is
  // built here and handed to both seams, and the comment saying why is most
  // of the seven lines.
  // Raised from 933 by the checkpoint scheduler being BUILT here — the
  // keeper's `save`, the HEAD lookup its rows are laned by, and the pair the
  // session signals. Most of the 54 lines is two pieces of reasoning a reader
  // cannot recover from the code: the doc handed to the scheduler is the
  // workspace RECORD rather than this document's content (it keys the
  // "anything changed" check on a frontier, and the record's is what the
  // store saves), and the pair's `flush` signals BEFORE it flushes, because
  // the edit flush's commit reaches `subscribeLocalUpdates` only on a later
  // microtask and a flush alone would find nothing armed. Raised again to 997
  // when `signal` was made TOTAL: it runs inside Loro's subscriber, where a
  // throw escapes as an unhandled rejection that reddens a whole run while
  // every test passes.
  // Raised again to 1011 by the branch-refresh signal: the browser record is
  // not readable at mount, so nothing re-read the branch plane once it
  // arrived and a document opened ON a variation kept naming the default one.
  // Most of the added lines is that reason — the bug is invisible in the
  // three lines of state that fix it.
  // Raised again to 1028 by kind parity on the versions seam. Two lines pick
  // the record seam by kind and supply the document's kind to it; the rest is
  // the two findings behind them, neither recoverable from the code. A note's
  // version ROWS were always written — a version is a frontier of the
  // workspace record — and only the seam that reads and restores one was
  // built from a backend a note never has. And `loadPast` asked the past
  // STATE its kind, which a tree-hosted document keeps in its node meta, so
  // the answer was always "not markdown": the fallback saved a canvas and
  // drew a note an empty viewer.
  // Raised again to 1031 by the SEARCH the URL sync now carries: one line of
  // wiring so a HEAD moved from the shared `?v=` banner refreshes the chip,
  // and three of reason. The reason is the whole entry — a `navigate` given a
  // pathname replaces the location, so the query a reader arrived with is
  // dropped by a repair they never asked for, and nothing about the call says
  // so.
  // +2 for the shared thread-write door: this page still chooses between the
  // markdown host and the spatial write per verb, so what it saves is the
  // command building rather than the branch.
  // +2: the tab's mark. The resolution is memoised because the resolver
  // PARSES — a fresh object every render re-arms the favicon's debounce on
  // every render instead of on a change to the document — and a `useMemo`
  // is two lines a call site cannot avoid paying.
  'apps/web/src/pages/BrowserDocumentPage.tsx': 1035,
  // +1 for a task list's checkbox, which is one import and one branch here:
  // the geometry and the measurement behind it (the vendored export face
  // carries no check glyph) live in `task-checkbox.ts`, 64 lines that never
  // entered this file.
  //
  // +3 for the `:name:` shortcode projection, and the shape is the same: one
  // import and one call, with the vocabulary and every word of its rationale
  // in `plugin-visual`'s `emoji/shortcode.ts`. It lands HERE because the
  // `case 'text'` below is the one place a text node's string reaches
  // layout, so every body-drawing surface gets it and none can be the one
  // that forgot — the alternative was a seam per surface, which is the
  // reference-seams defect. The two comment lines that survived say what
  // only this site can: that `inlineCode` deliberately does not expand.
  // +21 for `case 'image'`: an inline `![](...)` marks its run to paint
  // the picture rather than emitting the alt words, and an alt-less one
  // takes an atomic placeholder because the wrappable path trims a
  // whitespace-only run out of existence.
  // +46 for `emitWithIcons`, the icon half of the same idea and the one
  // place it could go. An emoji shortcode is a CHARACTER, substituted into
  // the string before the run is built; an icon is geometry, so a text node
  // has to be SPLIT into prose runs and icon runs — and the offsets that
  // split it are taken off the raw string, which only the site holding both
  // vocabularies can do. Its comment is most of the 46 and says exactly
  // that, because applying the two in the other order silently moves every
  // offset after the first emoji.
  // +7: that image asks the caller WHERE its picture is, through the
  // `resolveReference` seam a body already carries — so a written path can
  // be a workspace attachment instead of only an absolute URL.
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts': 1752,
  // Two layers grew this file, and the ceiling is the MEASURED total after
  // both, not either branch's number:
  //
  // +49: the comment pin carries how many messages its conversation holds —
  // the count run, its placement on the pin, and the `messagesByThread` the
  // layout derives from `threads`. The canvas was the last surface that did
  // not say it, so a reader crossing between it and the rail met the same
  // conversation described two ways.
  //
  // +207 for `composeProposals` and its two geometry helpers (ADR-0029
  // decision 1): where a change would land, and the bubble saying how many
  // are waiting. It reuses the comment layer's constants and placer rather
  // than growing a second set.
  //
  // +1: the leader edge carries `commentChrome`, so the keyed projection can
  // mark a conversation's whole chrome as the annotation layer. Without it the
  // leader is the one piece that cuts while the pin and bubble ramp.
  //
  // +12: `resolveContributions` also resolves each node's silhouette now, so
  // it takes the canvas and answers a third field. That is the whole growth —
  // a signature and a return that no longer fit one line each — and it buys
  // deleting the call site where `nodeOutlines` was resolved separately, which
  // is where `layoutSpatialEdges` came to be missing it.
  // +5 for the proposal bubble's own width: the import that names it grew
  // past one line, and the call site gained `density: 'compact'`. Nothing
  // was misfiled this time — the constant and its measured rationale live
  // in `comment-body.ts`, beside the comment width they are judged against,
  // so what is left here is the two lines that actually use them.
  //
  // +23 more for seeding every comment PIN as a placement obstacle before
  // the loop rather than pushing each as it is emitted: an anchor helper
  // both the pre-pass and the loop call, and the pass itself. It is the fix
  // for a real defect the widened candidate ring exposed — a bubble landing
  // on a neighbour's pin — and it has to be a pre-pass, since pushing each
  // pin as it is drawn protects only the comments after it.
  // +248 for the render theme layer (ADR-0030 decision 5): the theme is
  // resolved PER CANVAS at every nesting level of the recursion this file
  // owns (`withCanvasTheme`), so an embed reads its own facet before the
  // host's, and the ink, the default shape and the default routing it
  // implies are read where each node and edge is composed. Raised rather
  // than split: the resolution reads and rewrites `ResolvedLayoutOptions`,
  // and a module holding it would import the recursion's private options
  // type back from here. The palette a chrome previews resolves through the
  // same `pickThemeId`, so it sits here too.
  // +17 more for `paintOrderOf`, groups behind what they hold whatever the
  // stored order says. +4 for `annotates`, the link from a label's run back
  // to the edge or container it names, set where each label is placed.
  // +26 for the per-edge routing fold and the contributed router's call
  // site. The router's own resolution is `layout/contributed-router.ts`;
  // what stays here is the composer asking for it and falling back.
  // +8: `pullEdgeOntoOutlines` and `proposedEdgePath` each ask for a node
  // that may not be there, which is two lines apiece plus the sentence
  // saying a free end has no silhouette to be pulled onto.
  // 2444 -> 2463: the proposal layer draws a proposed LINE. Without it the
  // op stored a change nothing rendered — built but unwired, and every test
  // green over a board that said nothing had happened.
  // 2463 -> 2484 across ADR-0038 decision 3's reader conversion, in two
  // steps. +5: `isFrame` took the model import past the formatter's width
  // and wrapped it. +16: the other eight accessors joined that same list,
  // which is eight lines of the sixteen, and the rest is rationale that had
  // nowhere to live before — why the file arm's `?? ''` is unreachable
  // rather than a default, and why the dispatch asks what a node HOLDS.
  //
  // The seam does not shrink this file; the FLIP does, and only once the
  // arms it dispatches over stop existing. Said plainly because the earlier
  // entry promised the reduction at this step and the number went the other
  // way.
  // +3, and the entry above was right: the flip did NOT shrink this file. The
  // arms stopped existing and `composeNode` still dispatches over four cases,
  // because `nodeKind` has the same four answers the union's discriminant had
  // — plus `undefined`, which is a fifth case the union could not express and
  // the defensive branch now has a real caller for.
  // +4: the legend attached to the top-level scene (ADR-0040 decision 6) —
  // derived in legend/canvas-legend.ts, so the layout only asks and attaches.
  // +10: the tag library option (ADR-0040 decision 5) — declared here, applied
  // in tags/declared-colours.ts, so the layout only passes the canvas through.
  // +2: the edge-only entry point applies the library too, so a live drag
  // draws an edge in its declared colour — the same step the theme takes.
  // 2479 -> 1560 when the comment and proposal overlays and the options
  // vocabulary moved to their own modules (task #84). A pure move: no test
  // was rewritten and the suite went 1622 -> 1626 on the four cases the
  // extraction's own guards added.
  // +22 on the merge: the content seam's accessors and the reasons the
  // dispatch asks what a node HOLDS, landing in the file the overlay and
  // options extraction had just cut to 1560.
  'packages/canvas-render/src/layout/spatial-canvas.ts': 1582,
  // +21: a named side pair whose route runs through the edge's own box is
  // overruled — the search takes the edge as free (`selfThrough`, the
  // candidate list without its named sides), the render follows the anchor
  // pass's side over the edge's own, and a lone edge reaches the search.
  // +24 for the per-edge style resolver threaded through the anchor pass:
  // side choice reads the whole edge set, so one edge overriding the board's
  // routing has to be visible to it rather than applied afterwards.
  // +26: the stored-bend branch, taken before the self-edge shape and before
  // any computed routing (ADR-0037 slice 4). The route itself is
  // `bend-route.ts`; what lives here is choosing it.
  // +11 net, and the shape is worth reading: the reshape HOISTED three
  // `endNode` reads out of O(nodes) filters on the routing path (760k
  // calls per clustered layout, per the profile this rule records) and moved
  // the map lookup to model's own `nodeAtEnd`, deleting the local copy. What
  // is left is those hoists and the comments on them.
  // +16 for `rectAtEnd`: a free end is a DEGENERATE box at its point, which
  // is the whole of what lets this file draw one without a second routing
  // path beside the one it has.
  // Raised 2170 -> 2177: the bent branch carries `rounded` now, with the
  // reason it did not before.
  'packages/canvas-render/src/layout/edges/spatial-edges.ts': 2177,
  // +131 for the proposal card's press discipline and its render: the
  // bubble hit-test, the press remembered for the release, and the card
  // itself — which is its own file, so what lands here is the wiring.
  // +2 more: the card now says WHICH changes it decided, so this handler
  // forwards them instead of re-deriving the open set.
  // +2: the surface takes a class so it can draw past its own viewport, and
  // tells `useDragLayers` that a comment is in flight — both so the
  // annotation ramp is neither clipped by a re-fitted envelope nor mistaken
  // for an edit when a gesture takes the pin over.
  // +1: it also tells `useDragLayers` whether the committed scene is CURRENT,
  // which is what lets those layers hold their last frame until a drop's own
  // layout lands. Only the answer is passed; the holding is that hook's.
  //
  // -5, NET, over a seam that added 38: `openProposal` and the proposal
  // hit-test are geometry over the scene's chrome boxes, so they moved to
  // `lib/spatial/viewport.ts` (`viewportRevealingProposal`, `proposalAt`)
  // where the earlier splits put this file's pure core. This guard is what
  // asked the question — the growth read as the feature's cost until it
  // turned out two thirds of it was misfiled.
  // +30 for the session's look (ADR-0030 decision 6): the `style` prop, the
  // theme-fonts generation, the ask for the theme's family and the family
  // the in-place editors type in are inputs the editor threads to its
  // scene, its drag layers and its overlays, and the paper it paints is the
  // palette's surface. Threading is this file's job; there is nothing here
  // to move.
  // +32 NET for the bend affordance and the edge inspector, over blocks that
  // started at 53 and more. What came out: the handles are
  // `EdgeBendHandles.tsx`, their wiring to the gesture machine is
  // `EdgeBendLayer.tsx`, and `clientPointToRootLocal` moved to
  // `lib/spatial/viewport.ts` — an overlay taking its own press needs the
  // same client-to-root mapping, and two of them is how the pointer and the
  // geometry come to disagree about where a press landed.
  // 2785 -> 2791 for ADR-0038 decision 3's seam. Six lines: the accessor
  // import, and the double-press dispatch becoming a block that resolves the
  // node once instead of four `node?.type` tests that each narrowed their own
  // arm. The block is what costs, and it is not optional — an early return
  // would skip the `applyResult(result)` this handler ends with.
  // 2791 -> 2855 for the pen. Three branches, one per pointer phase, each a
  // few lines of dispatch plus the reason it is where it is: the press has
  // to sit after the annotation layer's chrome and take capture eagerly,
  // neither the samples nor the release may be snapped, and the samples are
  // reduced from the gesture MIRROR rather than the render's closure —
  // `pointermove` outruns React's commit, and a stroke accumulates where
  // every other gesture recomputes, so reading the closure drops all but the
  // first sample. The stroke's own arithmetic is `lib/spatial/freehand.ts`,
  // its state machine is the gesture reducer's `drawing` arm, and what the
  // hand watches is a new `InkDraftLayer.tsx` — so what stayed here is the
  // wiring only, which is what this file is for.
  // +31 for the Facets panel's tag row (ADR-0040 decision 6): the write
  // that fans a tag edit out over the selection as a CHANGE to each box's
  // own list (`retag`), beside the facet write that already fans out.
  // +8: the tag fan-out reads each object's CURRENT tags off the eager
  // chain's ref rather than the prop, so a second commit under a slow
  // parent cannot erase the first.
  // +5: the legend overlay (ADR-0040 decision 6), mounted from the scene
  // the worker answered — one line of wiring and its comment.
  // +14: two props for ADR-0040 decision 5 — the workspace's tag library
  // and its in-use vocabulary — each threaded to the layout, the drag
  // overlay and the Facets panel's tag row; the reading of both lives in
  // the pages' hook, not here.
  // 2843 + 83 on the merge: the pen's three pointer branches and the
  // gesture-mirror read (ADR-0038) beside ADR-0040's tag fan-out, legend
  // and library props. Two features, no overlap, nothing to reconcile.
  // Raised 2926 -> 2951 across the two ink-selection fixes: ink drawn over a
  // node was unselectable (the node hit-test settled the press before the
  // line one ran), and the marquee looked at boxes only. Both decisions live
  // OUT of this file, in `ink-hit.ts`; what is left here is the call sites
  // and their reasons.
  // Raised 2951 -> 2988: the press decides which MARK a stroke joins (the
  // rule itself is `stroke-group.ts`) and the release remembers what the
  // next one is judged against.
  // Raised 2988 -> 3011: shift on INK, which the multi-select branch above
  // it cannot see — ink wins a press by leaving `hitId` undefined, so
  // without its own arm holding shift destroyed the selection it was meant
  // to grow.
  // 3011 -> 3025 -> 3015, which is the ratchet working in both directions
  // in one change. The +14 was the REASON rather than the rule: one line
  // drops a held edge on a shift-press while ink survives, and what
  // separates the two kinds had nowhere to be written but beside it. The
  // -10 is what moving the per-kind decisions to `element-pick.ts` gave
  // back — three hit-tests two hundred lines apart became one call, and the
  // context menu's two duplicate edge probes went with them.
  // 3015 -> 3016: the node lock became a predicate beside the path lock
  // instead of a swapped box list, so the menu's "locked included" is one
  // statement per kind rather than two different mechanisms.
  // Raised 3016 -> 3097 for the ink drag: the press arm that decides what
  // travels, the offset the selection highlight is drawn at while it does,
  // and the release branch that keeps what the marquee used to do for a
  // press ON ink — the double-press label and the root focus, both found by
  // the full browser run rather than by reading.
  // Raised 3097 -> 3126 for the `attach` verb's wiring: the end handles
  // beside the bend layer, the box the pointer is over threaded into the
  // target overlay, and the two release branches that now answer for a
  // re-attachment as well as a connect — the hit-test for `targetNodeId`,
  // and the source box the overlay marks instead of offering.
  // Raised 3126 -> 3194, +68, for naming `handlePointerMove`'s seven steps.
  // The file GREW and is more readable for it: 121 lines of guard chain
  // became seven named steps plus a handler that reads as the order they run
  // in, and each step's reason now sits on the step rather than in a run of
  // comments a reader has to attach to the right `if`. The cost is a doc
  // comment per step; the alternative — module functions — would have moved
  // 32 closed-over values into parameters and grown the file further.
  // Raised 3194 -> 3195, +1, for one IMPORT: `defaultCreateId` moved to
  // `lib/spatial/element-id.ts`, so one import line became two.
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx': 3195,
}

describe('the path form both ledgers are keyed with', () => {
  // Feeds the helper a backslash tail on the real root: it exercises the
  // normalisation, not a Windows run, which nothing here can do. Without it
  // the assertion reads back the backslashes, which is exactly what would
  // reach a ledger lookup there.
  it('answers forward slashes, whatever separator the walk produced', () => {
    expect(relativeToRepo(`${join(REPO_ROOT, 'packages')}\\mcp-server\\src\\x.ts`)).toBe(
      'packages/mcp-server/src/x.ts',
    )
  })
})

describe('file-size budget: files stay under 800 lines (shrink-only grandfather)', () => {
  const files = scanFiles()

  // The guard-that-never-reaches-its-subject discipline: a broken glob that
  // silently scans zero files would pass both assertions below vacuously.
  it('reaches a source tree of the size this repo actually has', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('flags no over-budget file outside FILE_SIZE_GRANDFATHER', () => {
    const unlisted = files
      .map((path) => ({ path, lines: lineCount(join(REPO_ROOT, path)) }))
      .filter(({ path, lines }) => lines > LINE_BUDGET && !(path in FILE_SIZE_GRANDFATHER))
      .map(({ path, lines }) => `${path}: ${lines} lines`)

    expect(unlisted).toEqual([])
  })

  it('holds every grandfathered file at or under its recorded ceiling', () => {
    const grown = Object.entries(FILE_SIZE_GRANDFATHER)
      .filter(([path]) => existsSync(join(REPO_ROOT, path)))
      .map(([path, ceiling]) => ({ path, ceiling, lines: lineCount(join(REPO_ROOT, path)) }))
      .filter(({ lines, ceiling }) => lines > ceiling)
      .map(
        ({ path, lines, ceiling }) =>
          `${path}: ${lines} lines, over its recorded ceiling of ${ceiling} — shrink it back, or raise the ceiling here deliberately`,
      )

    expect(grown).toEqual([])
  })

  it('holds no grandfather entry that has shrunk to budget — delete it instead', () => {
    const shrunk = Object.keys(FILE_SIZE_GRANDFATHER)
      .filter((path) => existsSync(join(REPO_ROOT, path)))
      .map((path) => ({ path, lines: lineCount(join(REPO_ROOT, path)) }))
      .filter(({ lines }) => lines <= LINE_BUDGET)
      .map(
        ({ path, lines }) => `${path}: ${lines} lines, at or under the ${LINE_BUDGET}-line budget`,
      )

    expect(shrunk).toEqual([])
  })

  it('holds no grandfather entry for a file that moved or was deleted', () => {
    const missing = Object.keys(FILE_SIZE_GRANDFATHER).filter(
      (path) => !existsSync(join(REPO_ROOT, path)),
    )
    expect(missing).toEqual([])
  })
})

/**
 * Test files over the SAME 800-line budget, on the same shrink-only contract
 * as FILE_SIZE_GRANDFATHER above: an entry is a ceiling, both sides are
 * guarded, and growing a listed file means raising its ceiling here in the
 * same diff.
 *
 * Why the same budget rather than a higher one, which is the question that
 * kept this exclusion silent. The case for a higher ceiling is that a test
 * file legitimately repeats setup, so it should be allowed to run larger.
 * Measured across this repo on 2026-09-19, that is not what the sizes say —
 * test files are barely larger than source files at every percentile:
 *
 * |            | median | p90 | p95 | p99  | max  |
 * |------------|--------|-----|-----|------|------|
 * | source (1058) |   99 | 341 | 517 | 1081 | 2843 |
 * | test (1443)   |  116 | 382 | 574 | 1266 | 3110 |
 *
 * A ratio of 1.09-1.17 does not pay for an exemption, and an exemption
 * nobody can date is the thing this ledger exists to remove. So the budget
 * is the one the checklist already states, and what differs is only which
 * files each ledger holds.
 *
 * Note what this does NOT claim: that a long test file carries the same
 * maintainability signal as a long source file. It claims only that the
 * justification offered for a higher ceiling is not supported by the sizes.
 * A shrink-only ratchet never demands shrinkage, so it does not fight a
 * test that honestly needs its setup — it only stops one growing unwatched.
 */
// Ten entries moved when ADR-0038's branch met ADR-0040's: two features
// touching the same files, and a test file grows with what it covers. The
// large ones are the two pinned SCOREBOARDS (`tool-surface-quality`, +89, and
// `editor-state.property`, +72) and the two command ledgers
// (`commands.test`, +111, `canvas-edit.test`, +33) — each one a table where a
// moved row is a reason somebody has to write down, so the growth IS the
// record. `gestures.test` and this file itself are new entries rather than
// raises: both crossed 800 for the first time on that merge.
const TEST_FILE_SIZE_GRANDFATHER: Record<string, number> = {
  // Raised 1611 -> 1643 for the workspaceId branch's two new assertions
  // (ADR-0041 S0-5's Members card): the browser-mode case that pins
  // workspaceId stays undefined when settingsDaemon is, and the paired-daemon
  // case that pins it to daemonView.workspace and drops it again on
  // disconnect.
  'apps/web/src/App.test.tsx': 1643,
  'apps/web/src/components/VersionTimeline.test.tsx': 1061,
  'apps/web/src/components/annotations/CommentsPanel.browser.test.tsx': 821,
  'apps/web/src/components/migration/DaemonDetectedBanner.test.tsx': 982,
  'apps/web/src/components/settings/PromoteWorkspaceSection.browser.test.tsx': 968,
  'apps/web/src/components/spatial-editor/SpatialEditor.browser.test.tsx': 2138,
  // Raised 2708 -> 2724, two lines for each of the eight ink entries the
  // ledger gained: `move-line`, `delete-line`'s sibling verbs (`set-line-`
  // ends/side/facet/label/bends/color) and `pointerdown-ink`. Each one is a
  // command kind this model does not drive — it reduces POINTER gestures
  // over generated NODES — and the ledger's fourth direction fails on a
  // `not modelled` the run DOES produce, so each entry is a sentence
  // somebody had to be able to defend rather than a line of boilerplate.
  // 2724 -> 2730 for the `attach` entries: two command kinds and the
  // `pointerdown-end` that arms them, all unreachable from this model for
  // the reason every other overlay gesture is — it generates node
  // interactions and never renders the handle the press starts on.
  'apps/web/src/components/spatial-editor/editor-state.property.test.ts': 2730,
  'apps/web/src/components/spatial-editor/gestures.test.ts': 864,
  'apps/web/src/lib/browser-idb-migration.browser.test.tsx': 1666,
  'apps/web/src/lib/document-sync-session.test.ts': 2768,
  // Raised 1550 -> 1615 with the two ink writes above: five examples for the
  // move (both ends, a node end held, the two no-ops) and the colour.
  // Raised 1615 -> 1675 with the three ink-fragment cases: a paste of pure
  // ink, the offset on every point a stroke owns, and the anchor bounds that
  // used to read Infinity over nodes alone.
  // Raised 1675 -> 1808 with the rest of the verbs a stroke stores and the
  // editor could not write — bends, label, arrowheads, the side a pinned end
  // leaves from and the free end that has none, a facet, and the colour
  // write against a line the canvas does not hold — plus the two
  // collection-picking siblings (`labelInkCommand`, `bendInkCommand`), whose
  // whole content is that a relation and a stroke of the same id go to
  // different writes. A table of ink verbs where every row is one example is
  // what stops the next one being added without one.
  // Raised 1808 -> 1936 with the five re-attachment cases: a relation moved
  // onto another box, the two it refuses (a self-loop, a box the canvas does
  // not hold), a stroke end dropped in empty space and one dropped on a box,
  // and the collection-picking sibling that answers nothing for a relation
  // aimed at empty space.
  'apps/web/src/lib/spatial/commands.test.ts': 1936,
  'apps/web/src/pages/BrowserDocumentPage.markdown.browser.test.tsx': 1063,
  'apps/web/src/pages/BrowserDocumentPage.test.tsx': 1035,
  'apps/web/src/pages/DaemonDocumentPage.test.tsx': 866,
  'apps/web/src/pages/DaemonIndexPage.test.tsx': 2109,
  'apps/web/src/pages/SettingsPage.test.tsx': 905,
  'apps/web/src/pages/use-browser-document-controller.test.ts': 1500,
  'packages/canvas-render/src/layout/comments.test.ts': 823,
  'packages/canvas-render/src/layout/edges/edge-rules.properties.test.ts': 843,
  'packages/canvas-render/src/layout/edges/edge-rules.test.ts': 1061,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.test.ts': 1331,
  'packages/canvas-render/src/layout/spatial-canvas.properties.test.ts': 965,
  // Raised 1200 -> 1240 for the curved-line layout case: the seam the
  // freehand pen rides, from facet through style to a rounded scene node.
  'packages/canvas-render/src/layout/spatial-canvas.test.ts': 1240,
  'packages/canvas-render/src/quality/drawing-score.test.ts': 843,
  'packages/canvas-render/src/svg/backend.test.ts': 1184,
  'packages/canvas-render/src/tidy.test.ts': 1176,
  'packages/canvas-viewer/src/widget-entry.test.tsx': 1266,
  'packages/loro-adapter/src/loro-bridge.test.ts': 1308,
  'packages/mcp-server/src/server/app.server-mode.test.ts': 815,
  'packages/mcp-server/src/server/app.test.ts': 1339,
  // Its own entry, and it counts ITSELF: the number is what the file is
  // after the entry is in it, which is why this one is 10 past the reading
  // that first flagged it.
  // 858 -> 892 for the raises the two ink writes needed, each with the
  // reason beside it. That is the entry doing its job rather than growing:
  // a raise costs a sentence, so a change that widens a file pays for it in
  // the diff a reviewer reads.
  // 892 -> 909 for completing two of those sentences. A review found both
  // annotations stopping short of the ceiling they sit on — 2712 written
  // against 2724, 1675 against 1808 — which is the failure mode this entry
  // is the antidote to, one level up: an annotation that covers part of a
  // raise reads exactly like one that covers all of it.
  // 909 -> 917: this entry is self-referential, so every raise recorded
  // above costs this file the lines that record it — including these.
  // 917 -> 919 for the App.tsx raise above (ADR-0041 S0-5's Members card).
  // 919 -> 926 for the App.test.tsx raise above, the same increment's two
  // new assertions.
  'packages/mcp-server/src/server/file-size-budget.test.ts': 926,
  // 963 -> 976 at the merge with main. Both sides moved the same totals and
  // both REASONS were kept, because each explains a different change the
  // merged table now holds; only the numbers were re-measured. A scoreboard
  // whose rows are pinned exactly is one whose history is prose, so a merge
  // of two histories costs lines rather than losing one of them.
  'packages/mcp-server/src/server/mcp/tool-surface-quality.test.ts': 976,
  'packages/mcp-server/src/server/routes/document/workspaces.test.ts': 1286,
  'packages/mcp-server/src/server/routes/ws.test.ts': 980,
  'packages/mcp-server/src/server/store/document-store.compact.test.ts': 881,
  'packages/mcp-server/src/server/store/document-store.test.ts': 861,
  'packages/mcp-server/src/server/store/file-gc-sweeper.test.ts': 985,
  'packages/server-core/src/tools/canvas-edit.test.ts': 3143,
  'packages/server-core/src/tools/facet-set.test.ts': 1320,
}

describe('file-size budget: test files, same 800-line budget, same shrink-only contract', () => {
  const testFiles = scanTestFiles()

  // Same guard-that-never-reaches-its-subject discipline as above: a filter
  // that stopped matching would pass every assertion below over an empty set,
  // which reads exactly like a clean tree.
  it('reaches a test tree of the size this repo actually has', () => {
    expect(testFiles.length).toBeGreaterThan(900)
  })

  it('flags no over-budget test file outside TEST_FILE_SIZE_GRANDFATHER', () => {
    const unlisted = testFiles
      .map((path) => ({ path, lines: lineCount(join(REPO_ROOT, path)) }))
      .filter(({ path, lines }) => lines > LINE_BUDGET && !(path in TEST_FILE_SIZE_GRANDFATHER))
      .map(({ path, lines }) => `${path}: ${lines} lines`)

    expect(unlisted).toEqual([])
  })

  it('holds every grandfathered test file at or under its recorded ceiling', () => {
    const grown = Object.entries(TEST_FILE_SIZE_GRANDFATHER)
      .filter(([path]) => existsSync(join(REPO_ROOT, path)))
      .map(([path, ceiling]) => ({ path, ceiling, lines: lineCount(join(REPO_ROOT, path)) }))
      .filter(({ lines, ceiling }) => lines > ceiling)
      .map(
        ({ path, lines, ceiling }) =>
          `${path}: ${lines} lines, over its recorded ceiling of ${ceiling} — shrink it back, or raise the ceiling here deliberately`,
      )

    expect(grown).toEqual([])
  })

  it('holds no test-file entry that has shrunk to budget — delete it instead', () => {
    const shrunk = Object.keys(TEST_FILE_SIZE_GRANDFATHER)
      .filter((path) => existsSync(join(REPO_ROOT, path)))
      .map((path) => ({ path, lines: lineCount(join(REPO_ROOT, path)) }))
      .filter(({ lines }) => lines <= LINE_BUDGET)
      .map(
        ({ path, lines }) => `${path}: ${lines} lines, at or under the ${LINE_BUDGET}-line budget`,
      )

    expect(shrunk).toEqual([])
  })

  it('holds no test-file entry for a file that moved or was deleted', () => {
    const missing = Object.keys(TEST_FILE_SIZE_GRANDFATHER).filter(
      (path) => !existsSync(join(REPO_ROOT, path)),
    )
    expect(missing).toEqual([])
  })

  // The two ledgers must not both claim a file: the source scan excludes test
  // files and this one requires them, so an overlap means one of the two
  // filters drifted.
  it('shares no path with the source ledger', () => {
    const shared = Object.keys(TEST_FILE_SIZE_GRANDFATHER).filter(
      (path) => path in FILE_SIZE_GRANDFATHER,
    )
    expect(shared).toEqual([])
  })
})

/**
 * This guard scans `apps/web/src` (and every `packages/*` and `tools/*`) while
 * living in mcp-server, so the natural local run for a web change — the
 * `web-jsdom` / `web-browser` projects — does not include it. Twice in one
 * session that produced the same push: green locally, red in CI on a file
 * this guard had been watching all along.
 *
 * `.claude/rules/app-web.md` had already said to run it by hand alongside the
 * web guards. That is a prose rung, and being written down is what it can do —
 * it cannot notice being forgotten. So pre-push runs it, and it costs the gate
 * nothing: across two real `lefthook run pre-push` runs this took 10.71s and
 * 7.74s, and each run's total equalled the `pnpm -r typecheck` beside it to the
 * centisecond. The equality is the claim worth keeping — the reading itself
 * swings ~40% with contention. That is why a guard whose failure CI would catch
 * anyway is still worth a local rung.
 *
 * Asserted here rather than in a test about lefthook, because this is the file
 * that knows WHY the entry has to exist — and the path is derived from
 * `import.meta.url` so moving this file fails loudly instead of leaving the
 * lefthook line pointing at nothing.
 */
describe('the budget guard is reachable before a push, not only in CI', () => {
  function prePushCommands(): string[] {
    const text = readFileSync(join(REPO_ROOT, 'lefthook.yml'), 'utf8')
    const start = text.indexOf('\npre-push:')
    if (start === -1) throw new Error('lefthook.yml has no `pre-push:` block')
    const rest = text.slice(start + 1)
    const nextTopLevel = rest.slice('pre-push:'.length).search(/\n(?=[A-Za-z_-]+:)/)
    const block = nextTopLevel === -1 ? rest : rest.slice(0, 'pre-push:'.length + nextTopLevel)
    return [...block.matchAll(/^ {6}run: (.+)$/gm)].map((match) => match[1].trim())
  }

  // A scan that stops matching reports its subject as satisfied — the same
  // shape as a passing run. Checked before anything is concluded from it.
  it('reads the pre-push block', () => {
    expect(prePushCommands().length).toBeGreaterThanOrEqual(5)
  })

  it('is run by a pre-push command', () => {
    const self = relativeToRepo(fileURLToPath(import.meta.url))
    expect(prePushCommands().filter((command) => command.includes(self))).toHaveLength(1)
  })
})
