import {
  CoreUnaskable,
  constantRatioMeasureText,
  layoutMarkdownDocument,
  type MarkdownNoteRequest,
  type ReferenceSeams,
  type ReferenceWire,
} from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'

/** What `layoutMarkdownDocument` hands a core for `body` over `references`, or why it could not. */
export function askCore(body: string, references: ReferenceSeams) {
  const asked: MarkdownNoteRequest[] = []
  const core = fakeLayoutCore({
    markdown: {
      layoutMarkdown: (request) => {
        // A note's layout only: a comment never reaches these surfaces.
        if (request.kind === 'markdown') asked.push(request)
        return { refused: { code: 'malformed', reason: 'recording' } }
      },
    },
    // The refusal's notice is not what this records.
    query: { layoutQuery: () => ({ refused: { code: 'malformed', reason: 'recording' } }) },
  })
  try {
    layoutMarkdownDocument(body, {
      measure: constantRatioMeasureText,
      maxWidth: 400,
      references,
      core,
    })
  } catch (err) {
    if (err instanceof CoreUnaskable) return { asked, unaskable: err.reason }
    throw err
  }
  return { asked, unaskable: undefined }
}

/**
 * The reference wire a core is handed for `seams` — the only form of a
 * resolved reference that reaches a layout, since the core reads the loaded
 * records and the surface's extras itself and parses every body on its side.
 */
export function wireSeenByCore(seams: ReferenceSeams): ReferenceWire | undefined {
  return askCore('placeholder', seams).asked[0]?.references as ReferenceWire | undefined
}

/** The loaded record and the surface extra a wire holds for one reference. */
export function rowOf(wire: ReferenceWire | undefined, ref: string) {
  return {
    record: new Map(wire?.entries ?? []).get(ref),
    extra: new Map(wire?.extras ?? []).get(ref),
  }
}
