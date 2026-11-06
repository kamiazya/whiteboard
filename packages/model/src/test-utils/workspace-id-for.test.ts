import { describe, expect, it } from 'vitest'
import { workspaceCanonicalIdSchema } from '../ids.js'
import { workspaceIdFor } from './workspace-id-for.js'

describe('workspaceIdFor', () => {
  it('answers a canonical id, the same one for the same label', () => {
    const labels = ['lru-0', 'lru-1', 'compact-10-0', '', 'a'.repeat(300)]
    for (const label of labels) {
      expect(workspaceCanonicalIdSchema.safeParse(workspaceIdFor(label)).success, label).toBe(true)
      expect(workspaceIdFor(label)).toBe(workspaceIdFor(label))
    }
    expect(new Set(labels.map(workspaceIdFor)).size).toBe(labels.length)
  })
})
