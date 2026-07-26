import { describe, expect, it } from 'vitest'
import { checkDependencyDirection } from './direction-check.js'

describe('checkDependencyDirection', () => {
  it('passes canvas-model (zod-only dependency)', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-canvas-model',
      dependencies: { zod: '^4.0.0' },
    })
    expect(violations).toHaveLength(0)
  })

  it('passes canvas-codec depending on canvas-model + third-party libs', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-canvas-codec',
      dependencies: {
        '@kamiazya/whiteboard-canvas-model': 'workspace:*',
        zod: '^4.0.0',
        unified: '^11.0.0',
      },
    })
    expect(violations).toHaveLength(0)
  })

  it('fails a non-dev edge that reverses the architecture-map direction', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-canvas-model',
      dependencies: { '@kamiazya/whiteboard-canvas-codec': 'workspace:*' },
    })
    expect(violations).toEqual([
      {
        packageName: '@kamiazya/whiteboard-canvas-model',
        dependencyName: '@kamiazya/whiteboard-canvas-codec',
      },
    ])
  })

  it('ignores devDependencies entirely (only "dependencies" is inspected)', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-canvas-model',
      dependencies: {},
    })
    expect(violations).toHaveLength(0)
  })
})
