/**
 * What a person can DO to each kind of element, stated once.
 *
 * `element-pick.property.test.ts` closes one axis of this: a kind the model
 * gains is a compile error, because `ElementCollection` is derived from
 * `SpatialCanvas` and `ELEMENT_PICK_ROLE` is `satisfies Record<…>` over it.
 * What it does NOT close is the other axis. Its `EditorSurface` union is
 * written by hand and lists the seven places a line was forgotten in ONE
 * session; a surface added tomorrow is a surface nobody is asked about, and
 * the failure is the silent one — every suite reports the same green it did
 * yesterday over a board that grew a verb.
 *
 * So the verb axis is derived too. `EditorLeafCommand` is the single
 * mutation point for a spatial canvas, `COMMAND_FACTS` classifies every one
 * of its kinds, and the verb set the parity matrix is keyed on comes from
 * that classification rather than from a list. The chain is what makes it
 * load-bearing: a new command stops `tsc` on `COMMAND_FACTS`, a new verb
 * stops it on `ELEMENT_VERBS`, and a new verb row stops it until all four
 * collections have answered.
 *
 * What a cell may say is the point. `command` is CHECKED against
 * `COMMAND_FACTS` rather than believed, so it cannot be a claim; `gap:` and
 * `n/a:` owe a reason, for the same purpose `blastRadius: none:` does. And a
 * `gap:` that stops being one FAILS — the moment a command appears for that
 * verb and collection, the entry is stale and says so. That is the direction
 * this file exists for: the entry is how a missing affordance stays visible
 * instead of being rediscovered by whoever next tries to drag a stroke.
 */
import type { ClipboardFragment } from '@kamiazya/whiteboard-model'
import { clipboardFragmentSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { EditorLeafCommand } from '../../lib/spatial/commands.js'
import type { ElementCollection } from './element-pick.js'

/**
 * The verbs, one per thing a person does — never per (thing, kind) pair.
 *
 * Sharing a verb across collections is what makes the matrix able to ask a
 * question at all: `set-color` is one row, so "nodes and edges have it and
 * lines do not" is a cell rather than three unrelated command names. A verb
 * naming an element kind would be that sharing undone in a way no test could
 * see, so `a verb never names an element kind` below refuses one.
 */
const ELEMENT_VERBS = [
  'create',
  'delete',
  'move',
  // What an end is ON, as against what it looks like: `set-ends` writes the
  // arrowheads and `set-side` which way it leaves, and this one writes which
  // object the end is fixed to — the only part of an end that says anything
  // about the document.
  'attach',
  'resize',
  'reorder',
  'ungroup',
  'set-text',
  'set-label',
  'set-ends',
  'set-side',
  'set-bends',
  'set-color',
  'set-facet',
  'set-tags',
  'set-background',
  'set-resource',
] as const

type ElementVerb = (typeof ELEMENT_VERBS)[number]

/**
 * What one command kind is, in the two terms the matrix is keyed on — or the
 * reason it is on neither axis, which is a whole answer and not an omission.
 *
 * `note` is owed by a kind whose NAME points at one collection while it acts
 * on another; nothing else would tell a reader the disagreement was meant.
 */
type CommandFacts =
  | {
      readonly verb: ElementVerb
      readonly target: ElementCollection
      readonly note?: string
    }
  | `n/a: ${string}`

const THREAD_COMMAND =
  'n/a: a thread is the annotation layer beside the canvas, not an element of it (ADR-0026 decision 1); annotation-surface-parity.test.ts holds its verbs across surfaces' as const

const COMMAND_FACTS = {
  'create-node': { verb: 'create', target: 'nodes' },
  'delete-node': { verb: 'delete', target: 'nodes' },
  'move-node': { verb: 'move', target: 'nodes' },
  'resize-node': { verb: 'resize', target: 'nodes' },
  'reorder-nodes': { verb: 'reorder', target: 'nodes' },
  'set-text': { verb: 'set-text', target: 'nodes' },
  'set-node-color': { verb: 'set-color', target: 'nodes' },
  'set-node-facet': { verb: 'set-facet', target: 'nodes' },
  'set-node-tags': { verb: 'set-tags', target: 'nodes' },
  'set-node-file': { verb: 'set-resource', target: 'nodes' },
  'set-node-url': { verb: 'set-resource', target: 'nodes' },
  // A frame is a node that shows nothing (ADR-0038 decision 3), so its three
  // verbs are node verbs and land in the `nodes` column beside the rest.
  'create-group': { verb: 'create', target: 'nodes' },
  'set-group-label': { verb: 'set-label', target: 'nodes' },
  'set-group-background': { verb: 'set-background', target: 'nodes' },

  'create-edge': { verb: 'create', target: 'edges' },
  'connect-nodes': {
    verb: 'create',
    target: 'edges',
    note: 'it names the two NODES it joins because that is what the gesture starts from, and what it adds to the canvas is the edge between them',
  },
  'delete-edge': { verb: 'delete', target: 'edges' },
  'set-edge-label': { verb: 'set-label', target: 'edges' },
  'set-edge-ends': { verb: 'set-ends', target: 'edges' },
  'set-edge-side': { verb: 'set-side', target: 'edges' },
  'set-edge-end': { verb: 'attach', target: 'edges' },
  'set-edge-bends': { verb: 'set-bends', target: 'edges' },
  'set-edge-color': { verb: 'set-color', target: 'edges' },
  'set-edge-facet': { verb: 'set-facet', target: 'edges' },
  'set-edge-tags': { verb: 'set-tags', target: 'edges' },

  'create-line': { verb: 'create', target: 'lines' },
  'delete-line': { verb: 'delete', target: 'lines' },
  'move-line': { verb: 'move', target: 'lines' },
  'set-line-bends': { verb: 'set-bends', target: 'lines' },
  'set-line-label': { verb: 'set-label', target: 'lines' },
  'set-line-facet': { verb: 'set-facet', target: 'lines' },
  'set-line-ends': { verb: 'set-ends', target: 'lines' },
  'set-line-side': { verb: 'set-side', target: 'lines' },
  'set-line-end': { verb: 'attach', target: 'lines' },
  'set-line-color': { verb: 'set-color', target: 'lines' },
  'ungroup-ink': { verb: 'ungroup', target: 'lines' },

  'create-thread': THREAD_COMMAND,
  'move-thread': THREAD_COMMAND,
  'reply-to-thread': THREAD_COMMAND,
  'edit-thread-message': THREAD_COMMAND,
  'set-thread-status': THREAD_COMMAND,

  'set-canvas-facet':
    'n/a: the board itself carries the facet, so there is no element column for it to sit in',
  'set-canvas-tags':
    'n/a: the board itself carries the tags, so there is no element column for it to sit in',
  'set-edge-routing':
    'n/a: it writes the CANVAS facet through `withEdgeStyle`, so it is the board default every edge inherits rather than one edge being restyled',
  'set-line-jumps':
    'n/a: it names a line and writes the CANVAS facet through `withEdgeStyle` — line jumps are how crossings are drawn board-wide, not a property of any one stroke',
} satisfies Record<EditorLeafCommand['kind'], CommandFacts>

/**
 * `command, gap: …` is the fourth answer and the one a filled gap needs.
 *
 * A cell is (verb, collection), so the moment ANY command exists for the
 * pair it flips to `command` — and whatever the command does not reach goes
 * quiet again, which is the silence this file exists against. A stroke can
 * be nudged now and still cannot be dragged, and that is worth a sentence
 * rather than a cell that reads as finished.
 */
type Cell = 'command' | `command, gap: ${string}` | `gap: ${string}` | `n/a: ${string}`

/**
 * The matrix. `command` is verified against `COMMAND_FACTS`; the other two
 * are verified to still be true, which is what stops a `gap:` outliving the
 * hole it names.
 */
const VERB_PARITY = {
  create: { nodes: 'command', edges: 'command', lines: 'command' },
  delete: {
    nodes: 'command',
    edges: 'command',
    lines: 'command',
  },
  move: {
    nodes: 'command',
    edges:
      'n/a: an edge is a relation whose path is ROUTED from the boxes it joins, so there is nothing to translate — moving one means moving an end (set-ends) or placing a bend (set-bends)',
    lines: 'command',
  },
  resize: {
    nodes: 'command',
    edges: 'n/a: an edge has no box — its extent is wherever the router took it',
    lines:
      "n/a: a stroke's shape IS its points, so changing its size is redrawing it rather than resizing a box. A transform box over a selection would be a new affordance, not this verb",
  },
  reorder: {
    nodes: 'command',
    edges:
      'n/a: paint order is the scene composer’s fixed rule (every node, then every edge and stroke in stored order, then the annotation layer), so there is no z on an edge to write',
    lines:
      'n/a: the same fixed rule — a stroke carries no z either, and giving one a z is a model change before it is an editor one',
  },
  ungroup: {
    nodes:
      'n/a: a frame holds whatever its rectangle holds — JSON Canvas membership is geometric, so there is no group binding to dissolve',
    edges: 'n/a: edges are never grouped; each one stands for one relation',
    lines: 'command',
  },
  'set-text': {
    nodes: 'command',
    edges: "n/a: an edge's words are its LABEL, which is set-label",
    lines: 'n/a: ink says nothing (ADR-0038) — a stroke carrying prose would be a node',
  },
  'set-label': {
    nodes: 'command',
    edges: 'command',
    lines: 'command',
  },
  attach: {
    nodes:
      'n/a: a node is ON nothing — where it sits is its own geometry, which is move. Frame membership is geometric (ADR-0038), so there is no binding to re-point either',
    edges: 'command',
    lines: 'command',
  },
  'set-ends': {
    nodes: 'n/a: an end is a property of the thing drawn BETWEEN nodes, not of a node',
    edges: 'command',
    lines: 'command',
  },
  'set-side': {
    nodes: 'n/a: a side belongs to the end that meets the box, not to the box',
    edges: 'command',
    lines: 'command',
  },
  'set-bends': {
    nodes: 'n/a: a bend is a point on a drawn path',
    edges: 'command',
    lines: 'command',
  },
  'set-color': {
    nodes: 'command',
    edges: 'command',
    lines: 'command',
  },
  'set-facet': {
    nodes: 'command',
    edges: 'command',
    lines: 'command',
  },
  'set-tags': {
    nodes: 'command',
    edges: 'command',
    lines:
      'n/a: ink classifies nothing, so a line has no tags to write (ADR-0040 decision 2) — and `canvasLineSchema` has no `tags` field for one to live in',
  },
  'set-background': {
    nodes: 'command',
    edges: 'n/a: a line has no interior to fill',
    lines: 'n/a: a stroke has no interior to fill',
  },
  'set-resource': {
    nodes: 'command',
    edges: 'n/a: only a BOX shows something (ADR-0038 decision 3)',
    lines: 'n/a: only a BOX shows something (ADR-0038 decision 3)',
  },
} satisfies Record<ElementVerb, Record<ElementCollection, Cell>>

/**
 * What the CLIPBOARD carries, which the verb matrix above cannot see.
 *
 * Copy, cut, paste and duplicate issue no verb of their own — they build a
 * batch of `create-node`/`create-edge`, so every cell above reads `command`
 * for them and the family looks answered. What decides which kinds survive a
 * copy is the FRAGMENT's shape, so that is what this asks about, and it asks
 * the schema rather than a reader of it.
 */
const FRAGMENT_CARRIES = {
  nodes: 'carried',
  edges: 'carried',
  lines: 'carried',
} satisfies Record<ElementCollection, 'carried' | `gap: ${string}` | `n/a: ${string}`>

const NOUNS: Record<string, ElementCollection> = {
  node: 'nodes',
  nodes: 'nodes',
  edge: 'edges',
  edges: 'edges',
  line: 'lines',
  lines: 'lines',
}

const REASON_MIN = 24

const commandFacts = Object.entries(COMMAND_FACTS) as readonly [
  EditorLeafCommand['kind'],
  CommandFacts,
][]

const elementCommands = commandFacts.flatMap(([kind, facts]) =>
  typeof facts === 'string' ? [] : [{ kind, ...facts }],
)

/** Whether a command exists for this verb over this collection. DERIVED. */
const hasCommand = (verb: ElementVerb, collection: ElementCollection): boolean =>
  elementCommands.some((entry) => entry.verb === verb && entry.target === collection)

const cells = Object.entries(VERB_PARITY).flatMap(([verb, row]) =>
  Object.entries(row).map(
    ([collection, cell]) =>
      [verb as ElementVerb, collection as ElementCollection, cell as Cell] as const,
  ),
)

describe('every command kind says which verb it is and what it acts on', () => {
  it('classifies the whole union, and the union is the size this file was written against', () => {
    // A count beside an exhaustive `satisfies`, for the reason
    // `.claude/rules/coverage-ledger.md` asks for one: the type check proves
    // the table matches the union, and nothing else here would notice the
    // union having quietly become five entries.
    // 45 -> 47 with `set-edge-end` and `set-line-end`, the two writes behind
    // the `attach` verb; 47 -> 45 when the flat comment commands
    // (`create-comment`, `move-comment`, `set-comment-resolved`) gave way to
    // `move-thread` beside the thread commands already here.
    expect(commandFacts).toHaveLength(45)
    expect(elementCommands.length).toBeGreaterThan(30)
  })

  it('a verb never names an element kind, so one row can ask about all four', () => {
    for (const verb of ELEMENT_VERBS) {
      for (const noun of Object.keys(NOUNS)) {
        expect(
          verb.split('-').includes(noun),
          `the verb \`${verb}\` names the element kind \`${noun}\`. A verb that carries its own kind can never share a row with the other three, so the parity question it exists to ask ("nodes have this and lines do not") stops being askable. Name it for what a person DOES and let \`target\` carry the kind.`,
        ).toBe(false)
      }
    }
  })

  it('every declared verb is one some command actually uses', () => {
    for (const verb of ELEMENT_VERBS) {
      expect(
        elementCommands.some((entry) => entry.verb === verb),
        `no command declares the verb \`${verb}\`, so its whole row in VERB_PARITY is asking about something that no longer exists. Drop the verb and its row.`,
      ).toBe(true)
    }
  })

  it('a command whose name points at one kind while it acts on another says why', () => {
    for (const entry of elementCommands) {
      const named = entry.kind
        .split('-')
        .flatMap((word) => (NOUNS[word] === undefined ? [] : [NOUNS[word]]))
      const unique = [...new Set(named)]
      if (unique.length !== 1 || unique[0] === entry.target) continue
      expect(
        (entry.note ?? '').length,
        `\`${entry.kind}\` names \`${unique[0]}\` and declares \`${entry.target}\`. That may well be right — but a reader cannot tell it from a mis-declared target, which would make every cell derived from it wrong. Say why in \`note\`.`,
      ).toBeGreaterThanOrEqual(REASON_MIN)
    }
  })

  it('a canvas-level command says what it is instead of naming an element', () => {
    for (const [kind, facts] of commandFacts) {
      if (typeof facts !== 'string') continue
      expect(
        facts.length,
        `\`${kind}\`'s n/a reason is too short to be one`,
      ).toBeGreaterThanOrEqual(REASON_MIN)
    }
  })
})

describe('what each kind of element can have done to it', () => {
  it('a cell claiming a command has one', () => {
    for (const [verb, collection, cell] of cells) {
      if (!cell.startsWith('command')) continue
      expect(
        hasCommand(verb, collection),
        `${verb}/${collection} says \`command\` and no entry in COMMAND_FACTS declares that verb over that collection. Either the command was removed — in which case the cell is a \`gap:\` now and somebody has to say what that costs — or it was renamed and COMMAND_FACTS has not caught up.`,
      ).toBe(true)
    }
  })

  it('a gap or an exemption is still one — the command it denies does not exist', () => {
    // The direction this whole file is for. A `gap:` is how a missing
    // affordance stays visible; the moment it is filled, the entry becomes a
    // sentence that is no longer true, and a stale entry is worse than none
    // because it reads as a decision somebody took.
    for (const [verb, collection, cell] of cells) {
      if (cell.startsWith('command')) continue
      expect(
        hasCommand(verb, collection),
        `${verb}/${collection} says "${cell}", and a command for it now exists. Change the cell to \`command\` — and if the command does not reach every surface the verb should, say so as \`command, gap: …\` rather than letting the cell read as finished.`,
      ).toBe(false)
    }
  })

  it('a gap or an exemption owes a reason, not a word', () => {
    for (const [verb, collection, cell] of cells) {
      if (cell === 'command') continue
      expect(
        cell.slice(cell.indexOf(':') + 1).trim().length,
        `${verb}/${collection}: "${cell}" — a bare exemption is the omission with a word in front of it.`,
      ).toBeGreaterThanOrEqual(REASON_MIN)
    }
  })

  it('reports what each kind cannot have done to it, so the count is visible', () => {
    const gaps = cells.filter(([, , cell]) => cell.startsWith('gap:'))
    const byCollection = new Map<ElementCollection, number>()
    for (const [, collection] of gaps) {
      byCollection.set(collection, (byCollection.get(collection) ?? 0) + 1)
    }
    // Pinned exactly rather than as a ceiling, the way this repo's other
    // scoreboards are: an improvement is as loud as a regression, and closing
    // one of these is a diff that has to come past this line.
    //
    // The first reading was the finding. A `CanvasLine` stores seven things a
    // person could want changed — where each end is, which side it leaves a
    // box from, its bends, its colour, its label, its facets, and where the
    // whole stroke sits — and the editor wrote NONE of them. Ink could be
    // drawn, picked, banded, shift-added, ungrouped, locked and deleted, and
    // after that it was fixed. Nothing was red about that before this line.
    // All seven closed, and the count reached zero.
    //
    // It went back to one when `attach` arrived as a new ROW — a comments
    // cell naming the pin that cannot be dragged onto another box — and to
    // zero when comments left the canvas's collections: a thread is the
    // annotation layer beside the canvas (ADR-0026 decision 1), so its verbs
    // are held across surfaces by annotation-surface-parity.test.ts instead.
    expect(Object.fromEntries(byCollection)).toEqual({})
  })
})

describe('what a copy carries', () => {
  const carried = new Set(Object.keys(clipboardFragmentSchema.shape))

  it('reads the fragment schema itself, not a reader of it', () => {
    // The plausible-count assertion every scan in this repo owes: a probe
    // that stops seeing the schema reports every entry as a gap, which sends
    // the reader to the wrong file entirely.
    expect(carried.size).toBeGreaterThanOrEqual(4)
    expect(carried.has('nodes')).toBe(true)
  })

  it('a kind said to be carried has a field, and one said not to have none', () => {
    for (const [collection, cell] of Object.entries(FRAGMENT_CARRIES) as readonly [
      ElementCollection,
      (typeof FRAGMENT_CARRIES)[ElementCollection],
    ][]) {
      expect(
        carried.has(collection),
        cell === 'carried'
          ? `FRAGMENT_CARRIES says \`${collection}\` survives a copy and \`clipboardFragmentSchema\` has no such field.`
          : `FRAGMENT_CARRIES says "${cell}" and \`clipboardFragmentSchema\` now has a \`${collection}\` field. Change the entry to \`carried\`.`,
      ).toBe(cell === 'carried')
      if (cell !== 'carried') {
        expect(
          (cell as string).slice((cell as string).indexOf(':') + 1).trim().length,
          `${collection}: "${cell}" — a bare exemption is the omission with a word in front of it.`,
        ).toBeGreaterThanOrEqual(REASON_MIN)
      }
    }
  })

  it('the fragment type still has the two fields the editor builds it from', () => {
    // A type-level echo of the runtime check above, so a field renamed in the
    // model breaks here rather than only where a reader spells it.
    const fields: ReadonlyArray<keyof ClipboardFragment> = ['nodes', 'edges']
    expect(fields.every((field) => carried.has(field))).toBe(true)
  })
})
