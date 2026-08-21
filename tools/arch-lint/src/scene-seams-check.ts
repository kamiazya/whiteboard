import ts from 'typescript'

/**
 * Seams that every surface composing a spatial scene must pass, because
 * omitting one does not fall back to the same picture — it renders a
 * DIFFERENT one, silently.
 *
 * `layoutSpatialCanvas` has four production call sites (the editor, the
 * read-only viewer, server-core's composer, and export's own
 * `buildSpatialScene`), each assembling its own options object, and nothing
 * makes them agree. Three seams have already been wired at some and missed at
 * others: `textFill`, the theme mode, and `highlightCode` — which shipped at
 * one of four and left export, the surface the change was FOR, drawing code
 * plain.
 *
 * Deliberately not a required field on `SpatialLayoutOptions`. The type cannot
 * tell a production surface from the twenty test files that construct the same
 * options and legitimately do not care, so requiring it would put
 * `highlightCode: null` in all of them — noise that teaches nothing. A seam
 * whose ABSENCE is a rendering difference belongs to the call sites that
 * render for a user, and that is what this checks.
 *
 * Optional seams that genuinely differ per surface (`onDegrade`,
 * `resolveReference`) are not listed, and neither are the ones canvas-render
 * already defaults to the right answer (`parseBody`, `geometry`) — forgetting
 * those costs nothing.
 */
export const REQUIRED_SCENE_SEAMS = ['highlightCode'] as const

const COMPOSITION_FUNCTIONS = new Set(['layoutSpatialCanvas', 'layoutSpatialCanvasWithAnchors'])

export interface SceneSeamViolation {
  readonly seam: string
  readonly line: number
}

/**
 * Reports each production composition of a spatial scene that omits a
 * required seam. Only the object literal passed AT the call is inspected: a
 * spread carries no name here, so a caller building options elsewhere is
 * reported and should either inline the seam or be added to this scan's
 * exemptions with a reason.
 */
export function scanSourceForSceneSeamOmissions(
  fileName: string,
  sourceText: string,
): SceneSeamViolation[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const violations: SceneSeamViolation[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCompositionCall(node)) {
      const options = node.arguments[1]
      if (options !== undefined && ts.isObjectLiteralExpression(options)) {
        const named = new Set(
          options.properties.flatMap((property) =>
            property.name !== undefined && ts.isIdentifier(property.name)
              ? [property.name.text]
              : [],
          ),
        )
        for (const seam of REQUIRED_SCENE_SEAMS) {
          if (!named.has(seam)) {
            violations.push({
              seam,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

function isCompositionCall(node: ts.CallExpression): boolean {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return COMPOSITION_FUNCTIONS.has(callee.text)
  return ts.isPropertyAccessExpression(callee) && COMPOSITION_FUNCTIONS.has(callee.name.text)
}
