/**
 * Writing a task checkbox's state back to its source line.
 *
 * Line-based on purpose: the markdown model carries no source positions
 * (they would break the parse/serialize round trip), and a toggle must touch
 * one character of one line, not re-serialize the body and reformat what the
 * author wrote.
 */

// quote prefixes, indentation, the list marker and its gap, then the box.
const TASK_LINE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\]\s)/
const FENCE = /^[ \t]*(`{3,}|~{3,})/

/** 1-based source lines holding a task item, in order, outside fenced code. */
export function taskLineNumbers(source: string): readonly number[] {
  const lines: number[] = []
  let fence: string | undefined
  source.split('\n').forEach((text, index) => {
    const opener = FENCE.exec(text)?.[1]
    if (fence !== undefined) {
      if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length) {
        fence = undefined
      }
      return
    }
    if (opener !== undefined) {
      fence = opener
      return
    }
    if (TASK_LINE.test(text)) lines.push(index + 1)
  })
  return lines
}

/**
 * `source` with the task item on 1-based `line` flipped between `[ ]` and
 * `[x]`; the source unchanged when that line is not a task item.
 */
export function toggleTaskLine(source: string, line: number): string {
  const lines = source.split('\n')
  const text = lines[line - 1]
  if (text === undefined || !TASK_LINE.test(text)) return source
  lines[line - 1] = text.replace(
    TASK_LINE,
    (_, before: string, box: string, after: string) =>
      `${before}${box === ' ' ? 'x' : ' '}${after}`,
  )
  return lines.join('\n')
}
