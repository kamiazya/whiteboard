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
import {
  collectStaleIssues,
  isCheckableResource,
  issueDocumentsFrom,
  unwrapToolResult,
} from './stale-issues-lib.mjs'

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

// --- What the daemon answers, and the two ways this check went blind to it.
//
// Both fixtures below are REAL payloads, captured from the dev daemon on
// 2026-09-22 while the hook was reporting "nothing to report — 0 of 0" over a
// workspace holding 57 documents. Neither is invented, because the point of
// each is a shape nobody would think to invent.

test('a tool-level error is raised, not returned as an empty result', () => {
  // `wb_document_get` became a BATCH read; the hook kept sending the singular
  // `documentId`. The transport succeeds and the FAILURE rides in the result,
  // so a reader that only checks `payload.error` sees `structuredContent`
  // missing and calls it an empty document. Every document then fails the
  // `type === 'issue'` test, and the check reports a clean backlog.
  const captured = {
    jsonrpc: '2.0',
    id: 2,
    result: {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Input validation error: Invalid arguments for tool wb_document_get: documentIds: Invalid input: expected array, received undefined, Unrecognized key: "documentId"',
        },
      ],
    },
  }
  assert.throws(() => unwrapToolResult('wb_document_get', captured), /documentIds/)
  // And the JSON-RPC-level error it already handled keeps working.
  assert.throws(
    () => unwrapToolResult('wb_document_list', { error: { message: 'no such tool' } }),
    /no such tool/,
  )
  assert.deepEqual(unwrapToolResult('ok', { result: { structuredContent: { documents: [] } } }), {
    documents: [],
  })
})

test('the batch read is matched back to its listing, and what it could not read is counted', () => {
  const listed = [
    { documentId: 'A', path: 'issues/a', name: 'A' },
    { documentId: 'B', path: 'notes/b', name: 'B' },
    { documentId: 'C', path: 'issues/c', name: 'C' },
    { documentId: 'D', path: 'issues/d', name: 'D' },
    { documentId: 'E', path: 'issues/e', name: 'E' },
  ]
  const fetched = {
    documents: [
      {
        documentId: 'A',
        frontmatter: {
          type: 'issue',
          generated: { at: AUG_23, by: 'process:whiteboard-server' },
          facetsRaw: { sources: [{ resource: 'apps/web/src/main.tsx' }] },
        },
      },
      // A note is not an issue and is simply not carried.
      { documentId: 'B', frontmatter: { type: 'note' } },
      // Sources written as bare strings rather than OKF `{ resource }`
      // entries. Half this backlog is written that way and it names the same
      // path, so it is READ — silently skipping it is how a declaration that
      // was made gets judged as absent.
      {
        documentId: 'C',
        frontmatter: {
          type: 'issue',
          generated: { at: AUG_23 },
          facetsRaw: { sources: ['apps/web/src/main.tsx'] },
        },
      },
      // This one really is unreadable: an entry naming no resource at all.
      {
        documentId: 'E',
        frontmatter: {
          type: 'issue',
          generated: { at: AUG_23 },
          facetsRaw: { sources: [{ note: 'a conversation' }] },
        },
      },
    ],
    failed: [{ documentId: 'D', reason: 'unreadable' }],
  }

  const read = issueDocumentsFrom(listed, fetched)
  assert.deepEqual(
    read.documents.map((d) => d.documentId),
    ['A', 'C', 'E'],
  )
  assert.deepEqual(read.documents[0].sources, [{ resource: 'apps/web/src/main.tsx' }])
  assert.equal(read.documents[0].generatedBy, 'process:whiteboard-server')
  assert.deepEqual(read.unreadableSources, ['issues/e'])
  // And a bare string is judged like any other source.
  assert.deepEqual(
    collectStaleIssues(read.documents, (path) =>
      path === 'apps/web/src/main.tsx' ? 'changed' : 'unchanged',
    ).map((f) => f.documentId),
    ['A', 'C'],
  )
  assert.deepEqual(read.failed, [{ documentId: 'D', reason: 'unreadable' }])
})
