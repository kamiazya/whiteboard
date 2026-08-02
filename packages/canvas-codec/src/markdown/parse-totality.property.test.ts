import { mdastFlowContentArbitrary } from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe } from 'vitest'
import { fc, fcTest, hasNoEmptyContainer, withDefaults } from '../test-utils/fast-check.js'
import { parseMarkdownBody, stringifyMarkdownBody } from './pipeline.js'

// A strictly weaker sibling to round-trip.property.test.ts's equality
// property: this one admits 'list' (and every other flow-content kind)
// because it only asserts totality (parse never throws), not round-trip
// equality — the bullet/tightness ambiguity that legitimately excludes
// 'list' from the equality property doesn't affect a totality check. This
// is the property that would have caught the `list.start: null` boundary
// coercion bug (see from-remark.ts).
// Empty containers are still excluded — that limitation is upstream and
// breaks re-parse outright, not just equality (see hasNoEmptyContainer).
const rootArbitrary = fc
  .array(mdastFlowContentArbitrary(2), { minLength: 1, maxLength: 4 })
  .map((children) => ({ type: 'root' as const, children }))
  .filter(hasNoEmptyContainer)

describe('markdown body parse totality (including lists)', () => {
  fcTest.prop([rootArbitrary], withDefaults({ numRuns: 100 }))(
    'parseMarkdownBody(stringifyMarkdownBody(x)) never throws',
    (root) => {
      const text = stringifyMarkdownBody(root)
      parseMarkdownBody(text)
    },
  )
})
