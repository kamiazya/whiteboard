import type { TextRunNode } from '@kamiazya/whiteboard-scene'
import { uaxSegments } from './uax-segments.js'

/**
 * U+FFFC OBJECT REPLACEMENT CHARACTER — what a run that PAINTS rather than
 * spells (an icon, an alt-less image) answers when a break decision is taken
 * against it. Its UAX #14 class is CB, which is what makes the answer right
 * in both directions: `。` may still not open a line after it (LB13 outranks
 * CB), and an ordinary character may. The placeholder these runs actually
 * carry is an EM SPACE, so asking UAX #14 about the text would say a picture
 * is a space and a break after a space is always allowed — which is the
 * shape the original report arrived in, a full stop alone under an icon.
 */
const OBJECT_REPLACEMENT = '￼'

/** The character a break decision on this run's left edge is taken against. */
export function headCharacter(text: string, paints: TextRunNode['paints']): string {
  if (paints !== undefined) return OBJECT_REPLACEMENT
  const head = [...text].at(0) ?? ''
  return /\s/.test(head) ? '' : head
}

/** The same, on its right edge. `''` means a break is already allowed here. */
export function tailCharacter(text: string, paints: TextRunNode['paints']): string {
  if (paints !== undefined) return OBJECT_REPLACEMENT
  const tail = [...text].at(-1) ?? ''
  return /\s/.test(tail) ? '' : tail
}

/** The wrapper's horizontal cursor and line counter, mutated in place. */
export interface LineCursor {
  x: number
  index: number
}

export interface InlineJunction {
  /** True when a line may be cut between what is placed and `head`. */
  breakableBefore(head: string): boolean
  /** Record that a break is allowed at the cursor, starting a new cluster. */
  allowBreakHere(): void
  /** Record what a run just placed leaves the cursor sitting against. */
  placed(text: string, paints: TextRunNode['paints']): void
  /** Move to the next line: the cursor, the cluster and the tail all reset. */
  startLine(): void
  /**
   * Move the stretch that the incoming text may not be parted from onto a
   * line of its own, so the text can follow it there. Answers false when
   * that stretch is the whole line — there is nowhere to move it to, and the
   * caller's ordinary break stands rather than looping.
   */
  relocateCluster(): boolean
}

/**
 * Where the line may be cut, carried ACROSS inline nodes.
 *
 * `layoutPhrasing` decides breaks one `emit` call at a time and every inline
 * node is its own call, so without this the junction between two of them is
 * a break opportunity by accident: `` `code` `` followed by `。`, or
 * `**強調**` followed by it, put a closing character at the start of a line
 * however firmly UAX #14 forbids it. Measured on the wrapping scoreboard,
 * four such lines over three corpus cases while the same rule held perfectly
 * inside a single run — which is what made it a seam defect rather than a
 * line-breaking one.
 *
 * The junction is asked of `uaxSegments`, never of a character table of this
 * package's own: deciding where a line may break is delegated to UAX #14
 * (see this package's rule, decision 12) and the boundary between two inline
 * nodes is the same question as the boundary inside one.
 *
 * State: `tail` is the character the next break decision is taken against
 * (`''` once a break is already allowed here); `clusterRun`/`clusterX` are
 * the first run of the unbreakable stretch ending at that character and the
 * x it began at, which is what a forbidden break moves down instead of
 * splitting; `lineRun` is the first run on the current line, so a stretch
 * that IS the whole line is recognised as having nowhere to go.
 */
export function createInlineJunction(
  runs: readonly TextRunNode[] & TextRunNode[],
  line: LineCursor,
  lineHeightPx: number,
): InlineJunction {
  let tail = ''
  let clusterRun = 0
  let clusterX = 0
  let lineRun = 0

  const allowBreakHere = () => {
    tail = ''
    clusterRun = runs.length
    clusterX = line.x
  }

  return {
    breakableBefore: (head) => tail === '' || head === '' || uaxSegments(tail + head).length > 1,
    allowBreakHere,
    placed: (text, paints) => {
      const next = tailCharacter(text, paints)
      if (next === '') allowBreakHere()
      else tail = next
    },
    startLine: () => {
      line.x = 0
      line.index += 1
      lineRun = runs.length
      allowBreakHere()
    },
    relocateCluster: () => {
      if (clusterRun <= lineRun) return false
      const dx = clusterX
      for (let i = clusterRun; i < runs.length; i++) {
        const run = runs[i] as TextRunNode
        runs[i] = {
          ...run,
          bbox: { ...run.bbox, x: run.bbox.x - dx, y: run.bbox.y + lineHeightPx },
        }
      }
      line.x -= dx
      line.index += 1
      lineRun = clusterRun
      clusterX = 0
      return true
    },
  }
}
