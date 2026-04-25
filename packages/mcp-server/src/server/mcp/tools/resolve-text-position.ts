// Pure helper that resolves anchored placement for text annotations. target is
// the anchor point, and align decides which edge of the text block target.x
// refers to. Without width, only textAlign changes.

export type TextAlign = 'left' | 'center' | 'right'

export interface ResolveTextPositionInput {
  target: { x: number; y: number }
  width?: number
  align?: TextAlign
}

export interface ResolveTextPositionResult {
  x: number
  y: number
  textAlign: TextAlign
}

export function resolveTextPosition(
  input: ResolveTextPositionInput,
): ResolveTextPositionResult {
  const textAlign: TextAlign = input.align ?? 'left'
  let x = input.target.x
  if (input.width !== undefined) {
    if (textAlign === 'center') x = input.target.x - input.width / 2
    else if (textAlign === 'right') x = input.target.x - input.width
  }
  return { x, y: input.target.y, textAlign }
}
