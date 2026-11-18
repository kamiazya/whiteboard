import type { SceneRefusal } from '@kamiazya/whiteboard-scene'

// What a surface draws where the Rust core refused a layout (ADR-0054 step 7,
// owner decision q81, D7d): a request past one of the core's caps, a number no
// answer can spell, or a host measurer that did not answer. It is a scene on
// the ordinary vocabulary, so every surface that draws a layout draws this one
// the same way. The core draws it (one box and its words, wrapped greedily,
// which is all a message needs); this file owns only the words.
//
// The words are owner decision D12's, drafted for review; they name no number,
// since a cap's value lives in the core and a sentence quoting it is one more
// place a raised cap would have to reach.

/** A layout the core refused, as `@kamiazya/whiteboard-core-wasm` answers it. */
export type LayoutRefusal = SceneRefusal

/** What a refusal says: a title, and a detail saying what happened and what the reader can do. */
export interface RefusalCopy {
  readonly title: string
  readonly detail: string
}

const TOO_MUCH = 'Too much to draw here'
const CANNOT = 'This could not be drawn'

/** The words for each reason the core refuses with that a person can act on. */
const COPY = {
  'too-many-elements': {
    title: TOO_MUCH,
    detail:
      'This board has more boxes, edges and lines than can be drawn at once. Split it into smaller boards.',
  },
  'referenced-elements': {
    title: TOO_MUCH,
    detail:
      'The boards shown inside this one hold more boxes, edges and lines together than can be drawn at once. Show fewer of them here, or open them on their own.',
  },
  bodies: {
    title: TOO_MUCH,
    detail:
      'The text here, with the notes it shows, is more than can be drawn at once. Show fewer notes here, or split the text.',
  },
  'too-large': {
    title: TOO_MUCH,
    detail: 'There is more here than can be drawn at once. Split it into smaller boards or notes.',
  },
  comments: {
    title: TOO_MUCH,
    detail:
      'This board has more comments than can be drawn at once. Resolve or delete some of the threads.',
  },
  proposals: {
    title: TOO_MUCH,
    detail:
      'This board has more proposed changes than can be drawn at once. Accept or reject some of them.',
  },
  fragments: {
    title: TOO_MUCH,
    detail:
      'There are more formulas and diagrams here than can be drawn at once. Split it into smaller boards or notes.',
  },
  'non-finite': {
    title: CANNOT,
    detail:
      'A position or size in it is too large to draw. Undo the last change, or restore an earlier version.',
  },
  'host-measure': {
    title: CANNOT,
    detail: 'The browser could not measure its text. Reload the page to try again.',
  },
  // Not the core's own reason: what a web page draws with when the core it
  // lays everything out with did not load (a dropped connection at boot).
  'core-unavailable': {
    title: CANNOT,
    detail:
      'The page did not finish loading what it draws with. Check your connection, then reload the page.',
  },
} as const satisfies Record<string, RefusalCopy>

/** What a refusal whose reason has no words of its own says, by its code. */
const GENERAL: Readonly<Record<LayoutRefusal['code'], RefusalCopy>> = {
  'input-too-large': {
    title: TOO_MUCH,
    detail: 'There is more here than can be drawn at once. Split it into smaller parts.',
  },
  malformed: {
    title: CANNOT,
    detail:
      'Something in it could not be drawn. Undo the last change, or restore an earlier version.',
  },
}

const isWorded = (reason: string): reason is keyof typeof COPY => Object.hasOwn(COPY, reason)

/** The words a refusal is drawn with. */
export function refusalCopy({ code, reason }: LayoutRefusal): RefusalCopy {
  return isWorded(reason) ? COPY[reason] : GENERAL[code]
}
