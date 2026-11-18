import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { Scene } from '@kamiazya/whiteboard-scene'
import type { FragmentAsk, FragmentEntry } from '../../fragment-ask.js'
import type { ReferenceWire } from '../../references/wire.js'
import { digestOf } from '../render-oracle/scene-dump.js'
import { answerText } from '../wasm/answer-text.js'

/**
 * The recorded answers of a markdown DOCUMENT's layout on each surface that
 * lays one out (ADR-0054 step 7, S18a), taken while the TypeScript still
 * does, so the core's markdown entry is held to them after it is gone.
 *
 * A surface is the options its root hands the layout, restated here as data
 * because canvas-render cannot import the roots:
 *
 * - `daemon`: server-core's `composeMarkdownPicture` under `wb_scene_render`
 *   (720px, the document theme, the MCP light appearance), with a `#Heading`
 *   part selected first as `canvas-render-svg.ts` does;
 * - `preview`: apps/web's `layoutMarkdownScene` behind the preview pane and a
 *   note's version history (the document theme, `style: 'document'`, the
 *   app theme, the fragment table its math and diagram seams answer from);
 * - `outline`: the same call behind the outline rail and a row's outline,
 *   handed nothing but a width;
 * - `thumbnail`: the same call behind a note row's picture, with references,
 *   theme and library but no fragments;
 * - `comment`: `layoutCommentBody` as `CommentBody.tsx` calls it.
 *
 * The measurer is `createFakeMeasure()`, which the core repeats bit for bit.
 * The scene is written as `scene_wire` writes it (`answerText`); a body whose
 * scene runs to megabytes is held as its length and FNV digest instead.
 */

type Surface = 'daemon' | 'preview' | 'outline' | 'thumbnail' | 'comment'

/**
 * The recorded bodies past the markdown parser's bounds, by name: the core
 * draws each as its literal text (owner decision q81, D7a) where the
 * TypeScript drew remark's reading, so a replay holds them as a tolerated
 * class that must differ from the recording rather than equal it.
 */
export const PAST_THE_PARSER: ReadonlySet<string> = new Set([
  'quote 33 deep',
  'list 39 deep',
  'list 40 deep',
  '1024 delimiter runs',
  '1100 delimiter runs',
])

/** The body a record's id names: what follows its surface, less its variant. */
export const bodyName = (id: string): string => id.split('/').slice(1).join('/').split('#')[0] ?? ''

interface MarkdownInput {
  readonly id: string
  readonly surface: Surface
  readonly body: string
  readonly maxWidth: number
  /** The app theme a web surface paints an embedded board in; the daemon's is light. */
  readonly mode?: 'light' | 'dark'
  /** The daemon's `style` argument; the web surfaces always draw `'document'`. */
  readonly style?: string
  /** The families the surface's `fontAvailable` answers yes for. */
  readonly fonts?: readonly string[]
  /** The meta line's references, handed as the surface's bundle. */
  readonly references?: true
  /** The meta line's fragment table, or an empty one. */
  readonly fragments?: 'full' | 'empty'
  /** The meta line's tag library. */
  readonly library?: true
  /** The daemon's `#Heading` part. */
  readonly section?: string
  readonly density?: 'comfortable' | 'compact'
  /** Hold the answer as a digest rather than as text; set by the recorder past the scene text limit. */
  readonly digest?: true
}

/** A section that names no heading answers no scene: the daemon refuses the render. */
type Answer =
  | { readonly scene: string; readonly asked?: readonly FragmentAsk[] }
  | { readonly n: number; readonly h: number; readonly asked?: readonly FragmentAsk[] }
  | { readonly refused: 'section-not-found' }

export type MarkdownRecord = MarkdownInput & Answer

/**
 * What every record of a file may point at, written once as the file's first
 * line: one copy of the wire rather than one per record that hands it.
 */
interface MarkdownTables {
  readonly references: ReferenceWire
  readonly fragments: readonly FragmentEntry[]
  readonly library: TagLibrary
}

export interface MarkdownMeta extends MarkdownTables {
  readonly kind: 'meta'
}

/** `value` with every object's keys in code-unit order. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (typeof value !== 'object' || value === null) return value
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries.map(([key, item]) => [key, sortedKeys(item)]))
}

/**
 * The length and FNV digest of a scene spelled as `answerText` spells it with
 * every object's keys sorted. A digest record's own `n` and `h` are taken
 * over the TypeScript's key order, which is the order its objects were BUILT
 * in and differs between two objects of one kind (a run's `strong` and
 * `emphasis` follow the nesting they came from), so no writer of the core's
 * answer can repeat it; sorted, the text is a function of the scene's values
 * alone.
 */
export function sortedSceneDigest(scene: Scene): { readonly n: number; readonly h: number } {
  const text = answerText(sortedKeys(scene))
  if (text === undefined) throw new Error('markdown-document-oracle: a non-finite number')
  return digestOf(text)
}
