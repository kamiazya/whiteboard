#!/usr/bin/env node
// Regression coverage for stale-issues-lib.mjs.
// Run with: pnpm test:scripts (also wired into the CI "check" job).
//
// The fixtures are not invented. They are the six issue documents one session
// read, acted on, and found already resolved — each costing a measurement to
// discover. Four of them named something that had since changed or been
// deleted; two named something that had not, because the fix landed in a file
// the issue never mentioned. That 4-of-6 is what this check is worth, and
// pinning both halves is the point: a version that "catches everything" would
// be reporting on documents it cannot actually judge.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectStaleIssues, isCheckableResource } from './stale-issues-lib.mjs'

const AUG_23 = '2026-08-23T00:00:00.000Z'

/** The six real cases, with what each document named and what git says today. */
const CASES = [
  {
    name: 'bundled-visual-plugin — both named files were deleted',
    doc: {
      documentId: '01M0PXAZQRK02C9CXV6A507K88',
      path: 'issues/bundled-visual-plugin-lives-inside-the-engine',
      generatedAt: AUG_23,
      sources: [
        { resource: 'packages/facet-engine/src/visual.ts' },
        { resource: 'packages/facet-ui/src/visual-ui.tsx' },
      ],
    },
    verdicts: { 'packages/facet-engine/src/visual.ts': 'missing', 'packages/facet-ui/src/visual-ui.tsx': 'missing' },
    stale: true,
  },
  {
    name: 'card-context-menu — the fake source it named changed',
    doc: {
      documentId: 'a',
      path: 'issues/card-context-menu-grid-flake',
      generatedAt: AUG_23,
      sources: [{ resource: 'apps/web/src/test-utils/fake-files-source.ts' }],
    },
    verdicts: { 'apps/web/src/test-utils/fake-files-source.ts': 'changed' },
    stale: true,
  },
  {
    name: 'arch-lint web cycles — the guard it named changed',
    doc: {
      documentId: 'b',
      path: 'audit-arch-lint-web-cycles',
      generatedAt: AUG_23,
      sources: [{ resource: 'tools/arch-lint/src/repo-coverage.test.ts' }],
    },
    verdicts: { 'tools/arch-lint/src/repo-coverage.test.ts': 'changed' },
    stale: true,
  },
  {
    name: 'inspector gutter — the component it named changed',
    doc: {
      documentId: 'c',
      path: 'issues/inspector-dock-reserves-no-gutter',
      generatedAt: AUG_23,
      sources: [{ resource: 'apps/web/src/components/document-properties' }],
    },
    verdicts: { 'apps/web/src/components/document-properties': 'changed' },
    stale: true,
  },
  {
    name: 'mcp-node real data dir — the fix landed in a file it never named',
    doc: {
      documentId: 'd',
      path: 'mcp-node-tests-use-real-data-dir',
      generatedAt: AUG_23,
      sources: [{ resource: 'packages/mcp-server/src/server/http-server.test.ts' }],
    },
    verdicts: { 'packages/mcp-server/src/server/http-server.test.ts': 'unchanged' },
    stale: false,
  },
  {
    name: 'dist entrypoint — same shape, the build config it named never moved',
    doc: {
      documentId: 'e',
      path: 'dist-server-entrypoint-broken',
      generatedAt: AUG_23,
      sources: [
        { resource: 'packages/mcp-server/tsup.config.ts' },
        { resource: 'packages/mcp-server/tsconfig.server.json' },
      ],
    },
    verdicts: {
      'packages/mcp-server/tsup.config.ts': 'unchanged',
      'packages/mcp-server/tsconfig.server.json': 'unchanged',
    },
    stale: false,
  },
]

function inspectorFor(verdicts) {
  return (resource) => {
    const verdict = verdicts[resource]
    assert.ok(verdict !== undefined, `the fixture did not say what happened to ${resource}`)
    return verdict
  }
}

test('the six real cases split 4 stale / 2 not, for the documented reason', () => {
  const stale = collectStaleIssues(
    CASES.map((entry) => entry.doc),
    (resource) => {
      const owner = CASES.find((entry) => entry.verdicts[resource] !== undefined)
      return owner.verdicts[resource]
    },
  )
  const staleIds = new Set(stale.map((finding) => finding.documentId))
  for (const entry of CASES) {
    assert.equal(
      staleIds.has(entry.doc.documentId),
      entry.stale,
      `${entry.name}: expected stale=${entry.stale}`,
    )
  }
  assert.equal(stale.length, 4, 'exactly four of the six should be reported')
})

for (const entry of CASES) {
  test(entry.name, () => {
    const found = collectStaleIssues([entry.doc], inspectorFor(entry.verdicts))
    assert.equal(found.length === 1, entry.stale)
  })
}

test('a missing source and a changed one are reported apart, not merged', () => {
  const [finding] = collectStaleIssues(
    [{ documentId: 'x', path: 'p', generatedAt: AUG_23, sources: [{ resource: 'gone.ts' }, { resource: 'moved.ts' }] }],
    (resource) => (resource === 'gone.ts' ? 'missing' : 'changed'),
  )
  assert.deepEqual(finding.missing, ['gone.ts'])
  assert.deepEqual(finding.changed, ['moved.ts'])
})

test('a document with no sources is skipped, not guessed at', () => {
  // Nothing declared what it is about, so there is nothing to judge. Reporting
  // it would make every un-annotated document noise on every session start,
  // which is how a check like this stops being read.
  const found = collectStaleIssues(
    [{ documentId: 'x', path: 'p', generatedAt: AUG_23, sources: [] }],
    () => assert.fail('an inspector must not run for a document with no sources'),
  )
  assert.deepEqual(found, [])
})

test('a document with sources but no generated.at is skipped', () => {
  // "Changed since when?" has no answer without a stamp. Documents written
  // before the trust family shipped are in this state, and silently skipping
  // them is what lets the check be adopted without a backfill.
  const found = collectStaleIssues(
    [{ documentId: 'x', path: 'p', sources: [{ resource: 'a.ts' }] }],
    () => assert.fail('an inspector must not run without a generated.at'),
  )
  assert.deepEqual(found, [])
})

test('a URL source is not checkable and does not make a document look fresh', () => {
  // OKF §6.2 lets a resource be an absolute URL. git cannot judge one, so it
  // is skipped — but a document whose OTHER source moved is still reported,
  // rather than the unjudgeable one suppressing the judgeable one.
  assert.equal(isCheckableResource('https://example.com/spec'), false)
  assert.equal(isCheckableResource('docs/thing.md'), true)
  assert.equal(isCheckableResource('/bundle/relative.md'), true)

  const found = collectStaleIssues(
    [
      {
        documentId: 'x',
        path: 'p',
        generatedAt: AUG_23,
        sources: [{ resource: 'https://example.com/spec' }, { resource: 'moved.ts' }],
      },
    ],
    (resource) => {
      assert.notEqual(resource, 'https://example.com/spec', 'a URL must never reach git')
      return 'changed'
    },
  )
  assert.equal(found.length, 1)
  assert.deepEqual(found[0].changed, ['moved.ts'])
})

test('a bundle-relative source is checked against the repo root, without its leading slash', () => {
  const seen = []
  collectStaleIssues(
    [{ documentId: 'x', path: 'p', generatedAt: AUG_23, sources: [{ resource: '/docs/thing.md' }] }],
    (resource) => {
      seen.push(resource)
      return 'unchanged'
    },
  )
  assert.deepEqual(seen, ['docs/thing.md'])
})
