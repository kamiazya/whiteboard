import { describe, expect, it } from 'vitest'
import { checkAllowedDependencies } from './allowed-deps-check.js'

describe('checkAllowedDependencies', () => {
  it('passes when all non-internal deps are in the allowlist', () => {
    const violations = checkAllowedDependencies({
      name: '@kamiazya/whiteboard-canvas-model',
      dependencies: { zod: '^4.0.0' },
    })
    expect(violations).toHaveLength(0)
  })

  it('fails when an unlisted third-party dep appears', () => {
    const violations = checkAllowedDependencies({
      name: '@kamiazya/whiteboard-canvas-model',
      dependencies: { zod: '^4.0.0', lodash: '^4.17.0' },
    })
    expect(violations).toEqual([
      { packageName: '@kamiazya/whiteboard-canvas-model', dependencyName: 'lodash' },
    ])
  })

  it('ignores devDependencies entirely (only "dependencies" is inspected)', () => {
    const violations = checkAllowedDependencies({
      name: '@kamiazya/whiteboard-canvas-model',
      dependencies: {},
      devDependencies: { lodash: '^4.17.0' },
    })
    expect(violations).toHaveLength(0)
  })

  it('ignores internal workspace deps (already covered by direction-check)', () => {
    const violations = checkAllowedDependencies({
      name: '@kamiazya/whiteboard-canvas-codec',
      dependencies: { '@kamiazya/whiteboard-canvas-model': 'workspace:*' },
    })
    expect(violations).toHaveLength(0)
  })

  it('allows catalog: version specifiers', () => {
    const violations = checkAllowedDependencies({
      name: '@kamiazya/whiteboard-canvas-codec',
      dependencies: { zod: 'catalog:', unified: 'catalog:' },
    })
    expect(violations).toHaveLength(0)
  })
})
