import { describe, expect, it } from 'vitest'
import { buildMiniGraph, type MiniGraphInput } from './mini-graph.js'

const branch = (name: string, color: string, baseBranch?: string, baseVersionId?: string) => ({
  name,
  color,
  baseBranch,
  baseVersionId,
})

const version = (id: string, branchName: string, createdAt: string) => ({
  id,
  branchName,
  createdAt,
})

describe('buildMiniGraph', () => {
  it('renders a straight line for a single branch', () => {
    const input: MiniGraphInput = {
      head: 'main',
      branches: [branch('main', '#1971c2')],
      versions: [
        version('v3', 'main', '2026-04-23T03:00:00Z'),
        version('v2', 'main', '2026-04-23T02:00:00Z'),
        version('v1', 'main', '2026-04-23T01:00:00Z'),
      ],
    }
    const rows = buildMiniGraph(input)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.dotColor)).toEqual(['#1971c2', '#1971c2', '#1971c2'])
    expect(rows[0].connectorBefore).toBe(false)
    expect(rows[1].connectorBefore).toBe(true)
    expect(rows[2].connectorBefore).toBe(true)
  })

  it('marks versions outside the active HEAD branch as inactive rings', () => {
    const input: MiniGraphInput = {
      head: 'feature',
      branches: [branch('main', '#1971c2'), branch('feature', '#9333ea', 'main', 'v2')],
      versions: [
        version('f1', 'feature', '2026-04-23T04:00:00Z'),
        version('v2', 'main', '2026-04-23T02:00:00Z'),
      ],
    }
    const rows = buildMiniGraph(input)
    expect(rows[0].dotColor).toBe('#9333ea')
    expect(rows[0].active).toBe(true)
    expect(rows[1].active).toBe(false)
  })

  it('adds a branchOut label to the row referenced by baseVersionId', () => {
    const input: MiniGraphInput = {
      head: 'feature',
      branches: [branch('main', '#1971c2'), branch('feature', '#9333ea', 'main', 'v2')],
      versions: [
        version('f1', 'feature', '2026-04-23T04:00:00Z'),
        version('v2', 'main', '2026-04-23T02:00:00Z'),
        version('v1', 'main', '2026-04-23T01:00:00Z'),
      ],
    }
    const rows = buildMiniGraph(input)
    const v2Row = rows.find((r) => r.versionId === 'v2')
    expect(v2Row?.branchOut).toBe('feature')
  })

  it('joins multiple branch names with a comma when they share a baseVersionId', () => {
    const input: MiniGraphInput = {
      head: 'feature-b',
      branches: [
        branch('main', '#1971c2'),
        branch('feature-a', '#9333ea', 'main', 'v2'),
        branch('feature-b', '#e8590c', 'main', 'v2'),
      ],
      versions: [
        version('b1', 'feature-b', '2026-04-23T05:00:00Z'),
        version('a1', 'feature-a', '2026-04-23T04:00:00Z'),
        version('v2', 'main', '2026-04-23T02:00:00Z'),
        version('v1', 'main', '2026-04-23T01:00:00Z'),
      ],
    }
    const rows = buildMiniGraph(input)
    const v2Row = rows.find((r) => r.versionId === 'v2')
    expect(v2Row?.branchOut).toBe('feature-a, feature-b')
  })

  it('falls back to neutral gray for unknown branch names', () => {
    const input: MiniGraphInput = {
      head: 'main',
      branches: [branch('main', '#1971c2')],
      versions: [version('x', 'deleted-branch', '2026-04-23T01:00:00Z')],
    }
    const rows = buildMiniGraph(input)
    expect(rows[0].dotColor).toMatch(/^#[a-f0-9]{3,6}$/i)
    // The fallback color is a neutral outside the branch palette.
    expect(rows[0].dotColor).not.toBe('#1971c2')
  })

  it('preserves the input order of versions', () => {
    const input: MiniGraphInput = {
      head: 'main',
      branches: [branch('main', '#1971c2')],
      versions: [
        version('newer', 'main', '2026-04-23T05:00:00Z'),
        version('older', 'main', '2026-04-23T01:00:00Z'),
      ],
    }
    const rows = buildMiniGraph(input)
    expect(rows.map((r) => r.versionId)).toEqual(['newer', 'older'])
  })
})
