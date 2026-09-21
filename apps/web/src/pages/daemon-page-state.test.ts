// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { deriveDaemonPageState } from './daemon-page-state.js'

const canvas = { workspaceId: 'ws-1', path: 'notes/plan' }

// The steady-state input: resolution finished, a document exists at the
// selected path. Tests override single fields to walk the cascade.
const editingInput = {
  loading: false,
  loadError: null,
  canvas,
  documentCount: 3,
  documentAtPath: true,
  refusal: null,
}

describe('deriveDaemonPageState', () => {
  it('loading → loading, regardless of every other field (nothing else is trustworthy mid-resolve)', () => {
    expect(
      deriveDaemonPageState({
        ...editingInput,
        loading: true,
        loadError: 'stale error',
        documentCount: 0,
      }),
    ).toEqual({ kind: 'loading' })
  })

  it('loadError → load-degraded carrying the message verbatim', () => {
    expect(
      deriveDaemonPageState({ ...editingInput, loadError: 'The daemon request failed.' }),
    ).toEqual({ kind: 'load-degraded', message: 'The daemon request failed.' })
  })

  it('resolved identity + non-empty list + nothing at the path → document-missing carrying the path (a stale URL)', () => {
    expect(deriveDaemonPageState({ ...editingInput, documentAtPath: false })).toEqual({
      kind: 'document-missing',
      path: 'notes/plan',
    })
  })

  it('zero documents → workspace-empty, even when a URL asked for a path (an empty list answers for every path)', () => {
    expect(
      deriveDaemonPageState({ ...editingInput, documentCount: 0, documentAtPath: false }),
    ).toEqual({ kind: 'workspace-empty' })
  })

  it('unresolved identity with a non-empty list → editing (the no-canvas editor), never document-missing', () => {
    expect(deriveDaemonPageState({ ...editingInput, canvas: null, documentAtPath: false })).toEqual(
      { kind: 'editing' },
    )
  })

  it('steady state → editing', () => {
    expect(deriveDaemonPageState(editingInput)).toEqual({ kind: 'editing' })
  })

  it('a refusal → membership-refused carrying the code and workspaceId', () => {
    expect(
      deriveDaemonPageState({
        ...editingInput,
        refusal: { code: 'not_a_member', workspaceId: 'ws-1' },
      }),
    ).toEqual({ kind: 'membership-refused', code: 'not_a_member', workspaceId: 'ws-1' })
    expect(
      deriveDaemonPageState({
        ...editingInput,
        refusal: { code: 'requires_person_session', workspaceId: 'ws-1' },
      }),
    ).toEqual({
      kind: 'membership-refused',
      code: 'requires_person_session',
      workspaceId: 'ws-1',
    })
  })

  it('loading beats a refusal, same as every other field', () => {
    expect(
      deriveDaemonPageState({
        ...editingInput,
        loading: true,
        refusal: { code: 'not_a_member', workspaceId: 'ws-1' },
      }),
    ).toEqual({ kind: 'loading' })
  })

  it('the cascade is exhaustive over the documented surface', () => {
    // Every (loading × loadError × canvas × count × atPath × refusal) cell
    // maps to one of the six documented kinds — a seventh kind cannot appear
    // unnoticed.
    const kinds = new Set<string>()
    for (const loading of [true, false]) {
      for (const loadError of [null, 'boom']) {
        for (const c of [null, canvas]) {
          for (const documentCount of [0, 2]) {
            for (const documentAtPath of [false, true]) {
              for (const refusal of [
                null,
                { code: 'requires_person_session' as const, workspaceId: 'ws-1' },
                { code: 'not_a_member' as const, workspaceId: 'ws-1' },
              ]) {
                kinds.add(
                  deriveDaemonPageState({
                    loading,
                    loadError,
                    canvas: c,
                    documentCount,
                    documentAtPath,
                    refusal,
                  }).kind,
                )
              }
            }
          }
        }
      }
    }
    expect([...kinds].sort()).toEqual(
      [
        'document-missing',
        'editing',
        'load-degraded',
        'loading',
        'membership-refused',
        'workspace-empty',
      ].sort(),
    )
  })
})
