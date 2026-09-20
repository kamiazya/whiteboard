/**
 * The one refusal `wb_canvas_edit` and its helpers raise.
 *
 * Its own module so a helper split out of `canvas-edit.ts` can throw it
 * without importing the tool back — a value cycle `cycle-check.ts` refuses,
 * and the reason this type moved rather than being re-declared.
 *
 * `opIndex` is in the MESSAGE as well as on the class because only
 * `.message` survives the MCP error path, and a model repairing a rejected
 * batch needs to know WHICH op it got wrong.
 */
export class CanvasEditError extends Error {
  constructor(
    readonly opIndex: number,
    readonly op: string,
    detail: string,
  ) {
    super(`ops[${opIndex}] (${op}) could not be applied: ${detail}. Nothing was written.`)
    this.name = 'CanvasEditError'
  }
}

/**
 * Declared as a function rather than a closure so TypeScript narrows through
 * it: a `never`-returning const arrow does not act as a control-flow
 * terminator, which is what forced the double `if (!parsed.success)` this
 * replaced.
 *
 * It lives beside the error rather than in the tool for the reason the class
 * does — a helper split out of `canvas-edit.ts` raises it, and importing the
 * tool back would close a value cycle `cycle-check.ts` refuses.
 */
export function fail(opIndex: number, op: string, detail: string): never {
  throw new CanvasEditError(opIndex, op, detail)
}
