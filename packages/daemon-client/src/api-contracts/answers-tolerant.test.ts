/**
 * Strict requests, tolerant answers — held over the schemas as they ARE, not
 * over the text that declares them.
 *
 * arch-lint's `api-contract-response-tolerance.test.ts` reads top-level
 * `const`s for `.strict()` and cannot see a schema that arrives by `export {
 * x as y }`, nor one built from a strict piece declared in another package
 * (a search hit, a backlink, a tag count). So this walks the live schema
 * graph of everything this package publishes to the browser and finds every
 * object that refuses an unknown key.
 *
 * The walk is deliberately NOT `tolerantAnswer`'s: it descends into whatever
 * a definition holds rather than switching on the kinds that helper knows,
 * so a kind the helper forgot to reach still shows up here instead of
 * agreeing with it.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { clientTextMessageSchema } from '../sync-frames.js'
import {
  listDocumentsResponseSchema,
  listVersionsResponseSchema,
  listWorkspacesResponseSchema,
} from './document.js'
import { UPLOADABLE_IMAGE_TYPES } from './files.js'
import * as barrel from './index.js'
import { membershipRefusalSchema } from './membership.js'
import { signInRefusalSchema } from './sign-in.js'
import { syncWriteRefusalSchema } from './sync-write-refusal.js'
import { tenantPeopleRefusalSchema } from './tenant-people.js'
import { documentBacklinksResponseSchema } from './v1-answers.js'
import { workspacePeopleRefusalSchema } from './workspace-people.js'

const modules = import.meta.glob<Record<string, unknown>>(
  ['./*.ts', '!./*.test.ts', '!./*.test-helper.ts', '!./index.ts'],
  { eager: true },
)

function isSchema(value: unknown): value is { _zod: { def: Record<string, unknown> } } {
  return typeof value === 'object' && value !== null && '_zod' in value
}

/** Paths of every object in `root`'s graph that refuses a key it does not declare. */
function strictObjects(root: unknown): string[] {
  const found: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, path: string): void => {
    if (!isSchema(value) || seen.has(value)) return
    seen.add(value)
    const def = value._zod.def
    if (def.type === 'object' && isSchema(def.catchall) && def.catchall._zod.def.type === 'never') {
      found.push(path)
    }
    for (const [key, held] of Object.entries(def)) {
      if (key === 'getter' && typeof held === 'function') visit(held(), `${path}()`)
      else if (key === 'shape' && typeof held === 'object' && held !== null) {
        for (const [field, schema] of Object.entries(held)) visit(schema, `${path}.${field}`)
      } else if (Array.isArray(held)) {
        for (const [i, item] of held.entries()) visit(item, `${path}[${i}]`)
      } else visit(held, `${path}.${key}`)
    }
  }
  visit(root, '')
  return found
}

const published: ReadonlyMap<string, unknown> = new Map([
  ...Object.entries(barrel),
  ...Object.entries(modules).flatMap(([file, mod]) =>
    Object.entries(mod).map(([name, value]) => [`${file.slice(2)}:${name}`, value] as const),
  ),
])

const schemas = [...published].filter(([name, value]) => isSchema(value) && name.length > 0)
// A request is the daemon's to refuse an undeclared field in; everything else
// here is an answer, a refusal, or a piece of one.
const answers = schemas.filter(([name]) => !/RequestSchema$/.test(name))

describe('api-contracts: no schema the browser parses refuses an unknown key', () => {
  it('walks a real population, with the strict half and the derived answers present', () => {
    expect(answers.length).toBeGreaterThan(60)
    const requests = schemas.filter(([name]) => /RequestSchema$/.test(name))
    expect(requests.some(([, schema]) => strictObjects(schema).length > 0)).toBe(true)
    expect(published.has('createDocumentV1ResponseSchema')).toBe(true)
    expect(published.has('documentSearchResponseSchema')).toBe(true)
  })

  it('recognises a nested strict object, so a clean walk is not a blind one', () => {
    const nested = z.object({ hits: z.array(z.object({ id: z.string() }).strict()) })
    expect(strictObjects(nested)).toEqual(['.hits.element'])
  })

  it.each(answers)('%s declares nothing strict, at any depth', (_name, schema) => {
    expect(strictObjects(schema)).toEqual([])
  })
})

describe('api-contracts: every request refuses a key it does not declare', () => {
  const requests = schemas.filter(([name]) => /RequestSchema$/.test(name))

  it('walks a real population of requests', () => {
    expect(requests.length).toBeGreaterThanOrEqual(12)
  })

  // A stripped key is a 200 for a value that did not take effect: a typo'd
  // `displayname` renames nothing and says it did, and an older daemon drops a
  // newer client's `subtree` and performs the milder restore.
  it.each(requests)('%s is strict at its top level', (_name, schema) => {
    expect(strictObjects(schema)).toContain('')
  })
})

// A message a client posts upstream is a request one level down, and the
// top-level walk above cannot see it: it sits inside the sync envelope's
// `message` field, in a package module the walk's glob does not reach.
describe('sync-frames: every message a client sends refuses a key it does not declare', () => {
  it('holds each member of the union strict, so a second message cannot arrive tolerant', () => {
    expect(clientTextMessageSchema.options.length).toBeGreaterThan(0)
    expect(strictObjects(clientTextMessageSchema)).toHaveLength(
      clientTextMessageSchema.options.length,
    )
  })
})

// ---------------------------------------------------------------------------
// A new VALUE of an enum, the sibling of a new key.
//
// `tolerantAnswer` strips an unknown key, but an enum a newer daemon gave a new
// member fails the parse around it — and around is a whole listing, search or
// history. docs/contributing/architecture/wire-protocol.md carries the policy:
// a value that is only DISPLAYED degrades (absent, or the neutral member, via
// `.catch`), a value a DECISION is made on stays lockstep. This walk finds
// every enum a browser-parsed answer still reads strictly and requires each
// to be listed below with its reason, so a new enum is a decision rather than
// an accident, and a degraded one cannot quietly go back to strict.

type Def = Record<string, unknown>

/** Every enum reached through an answer, once, with where it was first seen. A `.catch` is a degrade boundary. */
function strictEnums(root: unknown, name: string): Map<string, string> {
  const found = new Map<string, string>()
  const seen = new Set<unknown>()
  const visit = (value: unknown, path: string): void => {
    if (!isSchema(value) || seen.has(value)) return
    seen.add(value)
    const def = value._zod.def as Def
    const closed = closedSetOf(def)
    if (closed !== undefined) found.set(setSignature(closed), path)
    switch (def.type) {
      case 'enum':
        found.set(signatureOf(def), path)
        return
      case 'catch':
        return
      case 'pipe':
        visit(def.in, path)
        return
      case 'object':
        for (const [field, schema] of Object.entries(def.shape as Def))
          visit(schema, `${path}.${field}`)
        return
      case 'record':
        visit(def.keyType, `${path}<key>`)
        visit(def.valueType, `${path}{}`)
        return
      case 'union':
        for (const [i, option] of (def.options as unknown[]).entries())
          visit(option, `${path}|${i}`)
        return
      case 'lazy':
        visit((def.getter as () => unknown)(), path)
        return
      case 'array':
        visit(def.element, `${path}[]`)
        return
      case 'intersection':
        visit(def.left, path)
        visit(def.right, path)
        return
      default:
        if (isSchema(def.innerType)) visit(def.innerType, path)
    }
  }
  visit(root, name)
  return found
}

function signatureOf(def: Def): string {
  return setSignature(Object.values(def.entries as Record<string, string>))
}

function setSignature(values: readonly unknown[]): string {
  return values.map(String).sort().join('|')
}

/** The values a single field may hold, when it is a literal or an enum. */
function fieldValues(schema: unknown): unknown[] | undefined {
  if (!isSchema(schema)) return undefined
  const def = schema._zod.def as Def
  if (def.type === 'literal') return def.values as unknown[]
  if (def.type === 'enum') return Object.values(def.entries as Def)
  return undefined
}

/**
 * The closed set spelled without `z.enum`: a literal of several values, a
 * union whose options are all literals, or a discriminated union's
 * discriminator values. A new value fails the parse the same way a new enum
 * member does, so it is the same decision. A single literal is a constant.
 */
function closedSetOf(def: Def): unknown[] | undefined {
  if (def.type === 'literal') {
    const values = def.values as unknown[]
    return values.length > 1 ? values : undefined
  }
  if (def.type !== 'union') return undefined
  const options = def.options as unknown[]
  const discriminator = def.discriminator
  const picked = options.map((option) => {
    if (typeof discriminator !== 'string') return fieldValues(option)
    if (!isSchema(option) || option._zod.def.type !== 'object') return undefined
    return fieldValues((option._zod.def.shape as Def)[discriminator])
  })
  if (picked.some((values) => values === undefined)) return undefined
  return picked.flatMap((values) => values ?? [])
}

const syncFrames = import.meta.glob<Record<string, unknown>>('../sync-frames.ts', { eager: true })
const answerSchemas = [
  ...answers,
  ...Object.values(syncFrames).flatMap((mod) =>
    Object.entries(mod).filter(([, value]) => isSchema(value)),
  ),
]

/**
 * The enums that stay strict, by their members, each with why. Both sides are
 * held: an enum found that is not here fails, and an entry here that no answer
 * reaches any more fails too, so a reason cannot outlive the enum it excused.
 */
const LOCKSTEP: ReadonlyMap<string, string> = new Map([
  [
    '1|2|3|4|5|6',
    'JSON Canvas 1.0 colour presets: the document vocabulary, held in lockstep with the model package this build ships, which draws a past state it can name or refuses it',
  ],
  [
    ['db', 'blobs', 'exports', 'files', 'other'].sort().join('|'),
    'storage report categories: exhaustive on purpose, so a category the daemon stopped counting fails loudly instead of rendering 0 B (see storageCategorySchema)',
  ],
  [
    ['no-offline', 'offline', 'bounded'].sort().join('|'),
    'replica tier on the replica-key answer: custody and lease semantics, a decision rather than a label — a key under a tier this build cannot read must not be held',
  ],
  [
    ['owner', 'member'].sort().join('|'),
    'workspace role: what a person may do next is decided by it, so an unknown role is refused rather than guessed at',
  ],
  [
    ['ai', 'human', 'system'].sort().join('|'),
    'operator kind as the BROWSER keeper stores and broadcasts it (browser-version-store, workspace-broadcast): rows its own build wrote. A daemon answer is read through operatorInfoAnswerSchema, which degrades',
  ],
  [
    [...UPLOADABLE_IMAGE_TYPES].sort().join('|'),
    'the Content-Type a browser sends with an upload (a request-side value, never read from an answer); the daemon answers an unlisted one with 415',
  ],
  [
    ['fit', 'move'].sort().join('|'),
    'a daemon-sent viewport command: an unknown mode is a request this build cannot perform, and an unreadable frame is dropped by the SSE reader, which is the right outcome for an event',
  ],
  [
    ['web-app', 'server-placeholder'].sort().join('|'),
    'the daemon-doctor view of which UI a daemon serves: read by the CLI beside the daemon it ships with, never by the hosted app',
  ],
  [
    signatureOfSchema(membershipRefusalSchema.shape.error),
    "membership refusal codes: read with safeParse and a failure falls back to the daemon's own message (apiErrorReason), so a code this build cannot name still shows its reason",
  ],
  [
    signatureOfSchema(workspacePeopleRefusalSchema.shape.error),
    'workspace-people refusal codes: read with safeParse beside apiErrorReason, as the membership ones',
  ],
  [
    signatureOfSchema(tenantPeopleRefusalSchema.shape.error),
    'tenant-people refusal codes: read with safeParse beside apiErrorReason, as the membership ones',
  ],
  [
    signatureOfSchema(signInRefusalSchema),
    'sign-in refusal codes: read with safeParse; an unrecognised refusal shows the generic sign-in failure',
  ],
  [
    ['spatial', 'markdown'].sort().join('|'),
    'document kind of a past version: it decides which reader draws the body, and a kind this build has no reader for cannot be shown, so the version reads as unreadable rather than as the wrong document',
  ],
  [
    ['node', 'point'].sort().join('|'),
    'what a line end is attached to: the model package this build ships draws an end it can place or refuses the past state, as with the colour presets',
  ],
  [
    ['false', 'true'].sort().join('|'),
    'signed-in session: a boolean, so no third value exists to arrive — what a session can be is the two arms, and a new state would be a new answer shape',
  ],
  [
    ['version_created', 'restore_started', 'restore_complete', 'viewport_request', 'agent_activity']
      .sort()
      .join('|'),
    'server sync frames: each type is an event the reader acts on, and a frame type this build cannot read is dropped by parseServerTextMessage, which is the right outcome for an event',
  ],
  [
    'client_ready',
    'client sync frames: the browser SENDS these and the daemon parses them strictly as a request, so a type the daemon has not heard of is refused rather than ignored',
  ],
  [
    signatureOfSchema(syncWriteRefusalSchema.shape.code.unwrap()),
    "sync write refusal codes: read with safeParse; a code this build cannot name is still a refusal, told with the keeper's own sentence",
  ],
])

function signatureOfSchema(schema: { _zod: { def: unknown } }): string {
  return signatureOf(schema._zod.def as Def)
}

describe('api-contracts: no browser-parsed enum fails on a member it has not heard of, unless listed', () => {
  const reached = new Map<string, string>()
  for (const [name, schema] of answerSchemas) {
    for (const [signature, path] of strictEnums(schema, name)) {
      if (!reached.has(signature)) reached.set(signature, path)
    }
  }

  it('walks a real population, with the degrade boundary and the strict half both present', () => {
    expect(answerSchemas.length).toBeGreaterThan(60)
    expect(reached.size).toBeGreaterThan(5)
    // A degraded enum is invisible to the walk; a strict one is not.
    const degraded = z.object({ kind: z.enum(['a', 'b']).catch('a') })
    const strict = z.object({ kind: z.enum(['a', 'b']) })
    expect(strictEnums(degraded, 'x').size).toBe(0)
    expect([...strictEnums(strict, 'x').keys()]).toEqual(['a|b'])
  })

  it('sees a closed set spelled as literals, which fails on a new value exactly as an enum does', () => {
    const literals = z.object({ custody: z.union([z.literal('held'), z.literal('sealed')]) })
    const multi = z.object({ mode: z.literal(['b', 'a']) })
    const framed = z.discriminatedUnion('type', [
      z.object({ type: z.literal('ready') }),
      z.object({ type: z.literal('gone'), at: z.string() }),
    ])
    const flag = z.discriminatedUnion('signedIn', [
      z.object({ signedIn: z.literal(true) }),
      z.object({ signedIn: z.literal(false) }),
    ])
    expect([...strictEnums(literals, 'x').keys()]).toEqual(['held|sealed'])
    expect([...strictEnums(multi, 'x').keys()]).toEqual(['a|b'])
    expect([...strictEnums(framed, 'x').keys()]).toEqual(['gone|ready'])
    expect([...strictEnums(flag, 'x').keys()]).toEqual(['false|true'])
    // One literal is a constant, not a set a newer daemon can grow.
    expect(strictEnums(z.object({ v: z.literal(1) }), 'x').size).toBe(0)
  })

  it('lists every strict enum with its reason', () => {
    const unlisted = [...reached].filter(([signature]) => !LOCKSTEP.has(signature))
    expect(
      unlisted.map(([signature, path]) => `${path} [${signature}]`),
      'degrade it (unknownIsAbsent / .catch) or list it in LOCKSTEP with why a new member must fail the parse',
    ).toEqual([])
  })

  it('lists no enum an answer no longer reads strictly', () => {
    expect([...LOCKSTEP.keys()].filter((signature) => !reached.has(signature))).toEqual([])
  })

  it('gives each listed enum a reason', () => {
    for (const [signature, reason] of LOCKSTEP) {
      expect(reason.length, signature).toBeGreaterThan(30)
    }
  })
})

describe('api-contracts: the enums that degrade, degrade', () => {
  const version = {
    id: 'v1',
    path: 'a',
    createdAt: '2026-01-01T00:00:00Z',
    elementCount: 1,
    auto: false,
  }

  it('lists a version row from a daemon that still sends branchName, without it', () => {
    const parsed = listVersionsResponseSchema.parse({
      versions: [{ ...version, branchName: 'main' }],
    })
    expect(parsed.versions).toHaveLength(1)
    expect(parsed.versions[0]).not.toHaveProperty('branchName')
  })

  it('reads an operator kind it has no word for as system, keeping the row', () => {
    const parsed = listVersionsResponseSchema.parse({
      versions: [{ ...version, operator: { kind: 'a-newer-actor' } }],
    })
    expect(parsed.versions[0]?.operator?.kind).toBe('system')
  })

  it('reads a workspace tier it does not know as not stated, keeping every workspace listed', () => {
    const parsed = listWorkspacesResponseSchema.parse({
      workspaces: [
        { workspaceId: 'a', tier: 'a-newer-tier' },
        { workspaceId: 'b', tier: 'offline' },
      ],
    })
    expect(parsed.workspaces.map((w) => w.tier)).toEqual([undefined, 'offline'])
  })

  it('reads a document kind it does not know as absent in a listing, a search and a backlink list', () => {
    const entry = { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'a', kind: 'a-newer-kind' }
    expect(
      listDocumentsResponseSchema.parse({
        documents: [{ path: 'a', documentId: 'x', kind: 'a-newer-kind' }],
      }).documents[0]?.kind,
    ).toBeUndefined()
    expect(
      documentBacklinksResponseSchema.parse({
        backlinks: [{ ...entry, contexts: [] }],
        unlinkedMentions: [],
      }).backlinks[0]?.kind,
    ).toBeUndefined()
  })
})
