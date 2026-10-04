// A fenced code block: one run per SOURCE line, each line cut rather than
// wrapped, tokenised through the `highlightCode` seam when the caller
// installs one.
import type { MdastFlowContent } from '@kamiazya/whiteboard-model/mdast'
import type { CodeBlockNode, SceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import type { CodeTokenLines, CodeTokenRole } from '../../highlight/code-token.js'
import type { FontDescriptor } from '../../measure.js'
import { clampAdvance } from '../../measure.js'
import {
  baselineIn,
  bodyFont,
  type Cursor,
  codeFontSizePx,
  codeLineHeightPx,
  panelPaint,
  placeFragment,
  type RenderedSvgFragment,
  type ResolvedMdastOptions,
} from './mdast-layout-options.js'
import { fitToWidth } from './truncate.js'

/**
 * The `highlightCode` seam, guarded to the never-throw rule its siblings
 * follow. Anything unusable — a throw, `undefined`, a non-array, or a line
 * count that disagrees with the source — degrades to one plain token per
 * line, which is exactly what the block rendered before highlighting existed.
 */
function tokenizeCode(
  lang: string,
  value: string,
  lineCount: number,
  options: ResolvedMdastOptions,
): CodeTokenLines {
  const plain: CodeTokenLines = value.split('\n').map((text) => [{ text }])
  if (options.highlightCode === undefined) return plain
  let tokenized: CodeTokenLines | undefined
  try {
    tokenized = options.highlightCode(lang, value)
  } catch {
    return plain
  }
  if (!Array.isArray(tokenized) || tokenized.length !== lineCount) return plain
  return tokenized.every((line) => Array.isArray(line)) ? tokenized : plain
}

/** One highlighted token as a scene run, at a position its line decided. */
function codeTokenRun(args: {
  fitted: { text: string; truncated?: boolean; overflows?: boolean }
  metrics: { advanceWidth: number }
  fill: string | undefined
  x: number
  y: number
  lineHeight: number
  baseline: number
  options: ResolvedMdastOptions
}): TextRunNode {
  const { fitted, metrics, fill, options } = args
  return {
    kind: 'textRun' as const,
    bbox: { x: args.x, y: args.y, w: clampAdvance(metrics.advanceWidth), h: args.lineHeight },
    baseline: args.baseline,
    text: fitted.text,
    code: true,
    ...(fitted.truncated ? { truncated: true as const } : {}),
    ...(fitted.overflows ? { overflows: true as const } : {}),
    appearance: {
      ...(options.textFill !== undefined ? { fill: options.textFill } : {}),
      ...(fill !== undefined ? { fill } : {}),
      fontFamily: options.theme.monoFontFamily,
      fontSize: codeFontSizePx(options.theme),
    },
  }
}

/**
 * One highlighted source line as scene runs, laid left to right.
 *
 * A code line never WRAPS — its indentation and its identity as one source
 * line are the point — so the only way to keep it inside the panel is to cut
 * it, exactly as an atomic inline run is cut. The line's width budget is
 * shared across its tokens: fitting each one against the full width would
 * let a highlighted line run out of a panel a plain line is cut to stay
 * inside.
 */
function codeLineRuns(
  tokens: readonly { text: string; role?: CodeTokenRole | undefined }[],
  index: number,
  ctx: {
    cursor: Cursor
    options: ResolvedMdastOptions
    font: FontDescriptor
    innerWidth: number
  },
): TextRunNode[] {
  const { cursor, options, font, innerWidth } = ctx
  const lineHeight = codeLineHeightPx(options.theme)
  const y = cursor.y + options.theme.codeBlockPaddingPx + index * lineHeight
  const baselineOf = (ascent: number) =>
    clampAdvance(baselineIn(lineHeight, codeFontSizePx(options.theme), ascent))

  const out: TextRunNode[] = []
  let x = 0
  for (const token of tokens) {
    const fitted = fitToWidth(token.text, font, options.measure, innerWidth - x)
    if (fitted.text === '') break
    const metrics = options.measure(fitted.text, font)
    const fill = token.role !== undefined ? options.syntax?.[token.role] : undefined
    out.push(
      codeTokenRun({
        fitted,
        metrics,
        fill,
        x: cursor.x + options.theme.codeBlockPaddingPx + x,
        y,
        lineHeight,
        baseline: baselineOf(metrics.ascent),
        options,
      }),
    )
    x += clampAdvance(metrics.advanceWidth)
    // Either flag means the line's remaining width is spent: a token kept
    // past `innerWidth` leaves the next `innerWidth - x` negative, which
    // `fitToWidth` reads as "no width to fit against" and answers by
    // returning the WHOLE token uncut, straight past the panel.
    if (fitted.truncated || fitted.overflows) break
  }
  return out
}

/**
 * A fenced block. A language whose `renderDiagram` answers takes over the
 * block entirely; everything else is laid out as source.
 *
 * One run per SOURCE line: a single `<text>` carrying the whole fence paints
 * it on one line — SVG collapses the newlines — so the code ran off the
 * right edge of a box sized for every line.
 */
export function layoutCodeBlock(
  node: Extract<MdastFlowContent, { type: 'code' }>,
  cursor: Cursor,
  options: ResolvedMdastOptions,
): SceneNode {
  if (node.lang) {
    let rendered: string | RenderedSvgFragment | undefined
    try {
      rendered = options.renderDiagram?.(node.lang, node.value)
    } catch {
      rendered = undefined
    }
    if (rendered !== undefined) {
      return placeFragment(rendered, cursor, options)
    }
  }
  const lines = node.value.split('\n')
  const height =
    lines.length * codeLineHeightPx(options.theme) + 2 * options.theme.codeBlockPaddingPx
  const font = bodyFont(options.theme.monoFontFamily, codeFontSizePx(options.theme))
  // One run per SOURCE line. A single `<text>` carrying the whole fence
  // paints it on one line — SVG collapses the newlines — so the code ran
  // off the right edge of a box sized for every line.
  // A code line never wraps — its indentation and its identity as one
  // source line are the point — so the only way to keep it inside the
  // panel is to cut it, exactly as an atomic inline run is cut.
  const innerWidth = options.maxWidth - 2 * options.theme.codeBlockPaddingPx
  const tokenLines = tokenizeCode(node.lang ?? '', node.value, lines.length, options)
  const runs: TextRunNode[] = tokenLines.flatMap((tokens, index) =>
    codeLineRuns(tokens, index, { cursor, options, font, innerWidth }),
  )
  const code: CodeBlockNode = {
    kind: 'codeBlock',
    bbox: { x: cursor.x, y: cursor.y, w: options.maxWidth, h: height },
    value: node.value,
    ...(node.lang ? { lang: node.lang } : {}),
    runs,
    appearance: panelPaint(options.theme, options.theme.panelOpacity),
    radius: options.theme.cornerRadiusPx,
  }
  cursor.y += height + options.theme.blockGapPx
  return code
}
