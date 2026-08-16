import { mdastFlowContentArbitrary } from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe, expect, it } from 'vitest'
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

describe('patched upstream: task-list checkbox on a continuation line', () => {
  // `mdast-util-gfm-task-list-item@2.0.0`'s exitCheck assumed a checkbox is
  // always inside a paragraph inside a listItem and asserted it. The
  // micromark side emits the token for a checkbox on a bullet's
  // CONTINUATION line too, where the paragraph is not in a list item — so
  // that input crashed the whole parse in any development build (production
  // no-ops devlop's assert, and instead stamps a bogus `checked` onto the
  // paragraph). patches/mdast-util-gfm-task-list-item@2.0.0.patch makes the
  // handler bail when the node is not a listItem, which is both total and
  // more correct than what production did.
  //
  // These pin the patch: they fail if it is ever dropped (the first throws,
  // the second is what the patch must not have broken to buy it).
  it('parses instead of crashing', () => {
    expect(() => parseMarkdownBody('*\n[ ] x')).not.toThrow()
  })

  it('still reads a real task list item as checked', () => {
    const root = parseMarkdownBody('- [x] done\n')
    const list = root.children[0]
    expect(list?.type).toBe('list')
    if (list?.type !== 'list') throw new Error('unreachable')
    expect(list.children[0]?.checked).toBe(true)
  })
})
