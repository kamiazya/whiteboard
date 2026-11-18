import type { CoreKeyedSvg, CoreSvgAsk } from '../canvas-core.js'

/** What the core drew for a request asking `ask`: the document's text, or its keyed projection. */
type AskedPicture = { readonly svg: string } | { readonly keyed: CoreKeyedSvg }

/** What a layout through the core may carry beside its scene: the picture it asked for, in either form. */
export type MaybePictured = { readonly svg?: string; readonly keyed?: CoreKeyedSvg }

/**
 * The core's picture for a request that asked one, in the form it asked for;
 * an answer without it is a defect in the core.
 */
export function askedPicture(
  ask: CoreSvgAsk,
  answer: { readonly svg?: string; readonly keyed?: CoreKeyedSvg },
): AskedPicture {
  const { svg, keyed } = answer
  if (ask.form === 'keyed' && keyed !== undefined) return { keyed }
  if (ask.form !== 'keyed' && svg !== undefined) return { svg }
  throw new Error('the core answered no SVG in the form a layout asked for')
}
