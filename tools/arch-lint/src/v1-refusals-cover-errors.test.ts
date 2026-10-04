/**
 * Every error class the shared layer defines is either answered by
 * `createServer`'s `/api/v1` routes or exempted here with the reason it
 * cannot reach them.
 *
 * Why: an error with no arm in `create-server.ts` escapes the handler and
 * Hono answers `500 text/plain` — `DocumentHasDescendantsError` did exactly
 * that on `DELETE …/documents/:id` while the legacy route answered 409 and the
 * MCP tool refused in words. Nothing in the type system relates "a class an
 * operation can throw" to "a status a route answers", so the relation is a
 * ledger: a class added anywhere in ports, model or server-core stops this test
 * until someone decides which side of it the class is on.
 *
 * `tools` below means the class is raised only by an MCP tool's own
 * execution, which no `/api/v1` handler calls (`createServer` mounts nine
 * operations: document create / list / resolve / delete, search, tags,
 * linkify, backlinks and the OKF projection). The ledger is checked from both
 * sides: an exempt class that now has an arm is stale, and an entry naming a
 * class that no longer exists is too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const CREATE_SERVER = 'packages/server-core/src/create-server.ts'
const SCANNED_PACKAGES = ['ports', 'model', 'server-core'] as const

const FACET_SET = 'raised by wb_facet_set alone; no /api/v1 route writes a facet through it'
const CANVAS_TOOLS = 'raised by the canvas tools (wb_canvas_edit / wb_scene_render / thread-edit)'
const VERSION_TOOLS = 'raised by wb_version_restore / wb_version_list; no /api/v1 route restores'
const WORKSPACE_EDIT = 'raised by wb_workspace_edit batch ops; /api/v1 mounts no workspace-edit'

/** A class with no arm in create-server.ts, and why no /api/v1 operation can raise it. */
const EXEMPT: Readonly<Record<string, string>> = {
  DocumentMoveIntoSelfError:
    'a move is wb_workspace_edit / document-move only; /api/v1 has no move',
  DocumentPathContestedError:
    'raised by resolving a document BY PATH, which only render/resolve-file-references does; /api/v1 addresses documents by id',
  DocumentContentLossError:
    'raised by a markdown write to a document with no kind; POST …/documents writes the kind at birth, so what it writes into is never unkinded',
  NotASpatialDocumentError: 'raised by the render tools on a document that is not spatial',
  FragmentNotFoundError: CANVAS_TOOLS,
  ThreadEditError: CANVAS_TOOLS,
  CanvasEditError: CANVAS_TOOLS,
  UnrepresentableChangeError: 'raised by canvas-propose, a tool-only batch of anchored changes',
  NodeNotFoundError: CANVAS_TOOLS,
  EdgeNotFoundError: CANVAS_TOOLS,
  PassageNotApplicableError: 'raised by body-edit / canvas-propose passages, tool-only',
  ElementLockedError: FACET_SET,
  FacetSetNeedsPayloadError: FACET_SET,
  DocumentHasNoFrontmatterError: FACET_SET,
  NodeTargetNeedsOneDocumentError: FACET_SET,
  NodeAndEdgeTargetError: FACET_SET,
  NodeAndCanvasTargetError: FACET_SET,
  VersionNotFoundError: VERSION_TOOLS,
  RestoreTargetExistsError: VERSION_TOOLS,
  SubtreeNeedsWorkspaceVersionError: VERSION_TOOLS,
  SubtreeTakesNoTargetError: VERSION_TOOLS,
  WorkspaceEditError: WORKSPACE_EDIT,
  DocumentKindUnknownError: 'raised by wb_document_get reading a document of no known kind',
}

/** Whether a class heritage clause names `Error` or one of its built-in subclasses. */
function extendsAnError(node: ts.ClassDeclaration): boolean {
  return (node.heritageClauses ?? []).some(
    (clause) =>
      clause.token === ts.SyntaxKind.ExtendsKeyword &&
      clause.types.some((type) => /Error$/.test(type.expression.getText())),
  )
}

function errorClassesIn(dir: string): string[] {
  const found: string[] = []
  for (const path of walkSourceFiles(dir)) {
    if (isTestPath(path)) continue
    const file = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined && extendsAnError(node)) {
        found.push(node.name.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return found
}

const classes = SCANNED_PACKAGES.flatMap((pkg) =>
  errorClassesIn(join(REPO_ROOT, 'packages', pkg, 'src')),
)
const createServerSource = readFileSync(join(REPO_ROOT, CREATE_SERVER), 'utf8')

/** An arm names the class itself or its cross-realm guard (`isWorkspaceNotFoundError`). */
const answered = (name: string): boolean =>
  countNamedUses(CREATE_SERVER, createServerSource, [name, `is${name}`]) > 0

describe('/api/v1 answers every error class the shared layer defines, or says why it cannot', () => {
  it('finds the classes it judges', () => {
    // A scan that found none would report every ledger entry stale and send a
    // reader to the wrong file; the repo holds fifty or so.
    expect(classes.length).toBeGreaterThan(30)
    expect(classes).toContain('DocumentHasDescendantsError')
    expect(classes).toContain('FacetWriteRejectedError')
  })

  it('has an arm in create-server.ts or a ledger entry for each', () => {
    const undecided = classes.filter((name) => !answered(name) && !(name in EXEMPT))
    expect(
      undecided,
      `${undecided.join(', ')}: add a REFUSALS arm in ${CREATE_SERVER}, or an EXEMPT entry saying why no /api/v1 operation raises it`,
    ).toEqual([])
  })

  it('names no exempt class that no longer exists', () => {
    expect(Object.keys(EXEMPT).filter((name) => !classes.includes(name))).toEqual([])
  })

  it('names no exempt class that now has an arm', () => {
    expect(Object.keys(EXEMPT).filter(answered)).toEqual([])
  })

  it('gives every exemption a reason of more than a word', () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason.split(/\s+/).length, name).toBeGreaterThan(3)
    }
  })
})
