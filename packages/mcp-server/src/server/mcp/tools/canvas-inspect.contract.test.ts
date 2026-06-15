import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { canvasInspectOutputSchema } from './canvas-inspect.js'
import {
  canvasInspectOutputSchema as schemaFromSummarize,
  summarizeCanvas,
} from './summarize-canvas.js'

// canvas_inspect derives its output type from a single Zod schema (z.infer).
// summarizeCanvas, the registered MCP outputSchema, and the tool execute return
// type all flow from this one schema, so the runtime payload always validates
// against the registered contract. The real one-sided-drift guard is the
// compile-time z.infer wiring in production code (caught by pnpm build); this
// test pins the runtime side and that both modules expose the same schema object.
describe('canvas_inspect output contract', () => {
  it('re-exports the same schema instance that summarize-canvas owns', () => {
    expect(canvasInspectOutputSchema).toBe(schemaFromSummarize)
  })

  it('validates a real summarizeCanvas payload against the registered schema', () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(list.length, new LoroMap())
    map.set('id', 'el-1')
    map.set('type', 'rectangle')
    map.set('x', 5)
    map.set('y', 6)
    map.set('width', 10)
    map.set('height', 20)

    const summary = summarizeCanvas(doc)

    const result = canvasInspectOutputSchema.safeParse(summary)
    expect(result.success).toBe(true)
  })
})
