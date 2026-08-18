import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { BlobStore, DocumentIndex, DocumentStore } from '@kamiazya/whiteboard-ports'

export interface ServerDeps {
  documentStore: DocumentStore
  blobStore: BlobStore
  /**
   * Where a document's placement lives. Separate from `documentStore`, which
   * owns one document's bytes and knows nothing about where it sits — and the
   * reason an agent-created document is one the user's canvas list can show:
   * both surfaces now write the same index.
   */
  documentIndex: DocumentIndex
  /**
   * How to measure text when laying a scene out. Optional because
   * server-core is a shared layer forbidden from loading a font itself
   * (architecture-map.md) — absent, the render/digest tools degrade to
   * canvas-render's `constantRatioMeasureText`, which matches no real
   * font.
   *
   * Asynchronous, and a factory rather than a value, because the real
   * implementation parses a font file: the composition root's own measurer
   * memoizes that parse, so calling this per request costs one resolved
   * promise and startup pays nothing for a server that never renders.
   */
  measure?: () => Promise<MeasureText>
}
