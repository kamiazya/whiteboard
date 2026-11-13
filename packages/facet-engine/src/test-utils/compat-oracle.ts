/**
 * The registry's read path, `resolveFacetPayload`, recorded for the Rust
 * registry to replay (`crates/core/facet-engine/tests/compat_oracle.rs`): every
 * key of a small plugin whose facets carry compat chains, crossed with payloads
 * of every version's shape, so each outcome is reached — a malformed key, a
 * facet nobody registers, a newer version, the current one, a chain walked to
 * the end, a chain with a step missing, a retained schema refusing, and a
 * version tag with leading zeros, which compares as its number.
 *
 * The manifest is the one file both languages load. The payload schemas are
 * written twice, as Zod here and as `compat-oracle/demo.contract.json` for the
 * Rust interpreter, and so are the migrations; the replay holds the two to the
 * same answers.
 */
import { decode, type Encoded, encode } from '@kamiazya/whiteboard-model/test-utils'
import { z } from 'zod'
import { pluginFromManifest } from '../manifest.js'
import { createFacetRegistry, type FacetRegistry } from '../registry.js'
import manifest from './compat-oracle/demo.manifest.json' with { type: 'json' }

const pointer = (name: string) => `facets/demo/demo.schema.json#/$defs/${name}`

/** A compat step, from the shape its retained schema parsed to the next version's. */
const MIGRATIONS = {
  'demo.note-v1': (old: unknown) => ({ title: (old as { body: string }).body }),
  'demo.note-v2': (old: unknown) => {
    const { title } = old as { title: string }
    return { text: title === 'x' ? 1 : title, size: 1, extra: true }
  },
  'demo.gap-v0': (old: unknown) => ({ k: (old as { old: string }).old }),
}

export function compatRegistry(): FacetRegistry {
  const host = {
    schemas: {
      [pointer('Note')]: z.object({ text: z.string(), size: z.number().optional() }),
      [pointer('NoteFirst')]: z.object({ body: z.string() }),
      [pointer('NoteSecond')]: z.object({ title: z.string() }),
      [pointer('Gap')]: z.object({ k: z.string() }),
      [pointer('GapOld')]: z.object({ old: z.string() }),
    },
    migrations: MIGRATIONS,
  }
  return createFacetRegistry([pluginFromManifest(manifest, host)])
}

const KEYS = [
  'demo.note/v0',
  'demo.note/v1',
  'demo.note/v2',
  'demo.note/v3',
  'demo.note/v03',
  'demo.note/v01',
  'demo.note/v00001',
  'demo.note/v4',
  `demo.note/v${'9'.repeat(400)}`,
  'demo.gap/v0',
  'demo.gap/v1',
  'demo.gap/v2',
  'demo.plain/v0',
  'demo.plain/v1',
  'other.thing/v0',
  'demo.missing/v0',
  'demo.note',
  'Demo.note/v3',
  'demo.note/v-1',
  '',
]

const PAYLOADS: readonly unknown[] = [
  { body: 'b' },
  { body: 1 },
  { title: 't' },
  { title: 'x' },
  { text: 's' },
  { text: 's', size: 2, z: 1 },
  { old: 'o' },
  { k: 'k', more: [1] },
  {},
  [],
  null,
  'text',
  5,
]

export interface CompatLine {
  readonly key: string
  readonly in: Encoded
  readonly out: string
  readonly value?: Encoded
}

function lineOf(registry: FacetRegistry, key: string, payload: unknown): CompatLine {
  const resolution = registry.resolveFacetPayload(key, payload)
  const base = { key, in: encode(payload), out: resolution.kind }
  switch (resolution.kind) {
    case 'dropped':
      return base
    case 'resolved':
      return { ...base, value: encode(resolution.value) }
    case 'preserved':
    case 'passthrough':
      return { ...base, value: encode(resolution.payload) }
  }
}

export function recordCompatLines(): readonly CompatLine[] {
  const registry = compatRegistry()
  return KEYS.flatMap((key) => PAYLOADS.map((payload) => lineOf(registry, key, payload)))
}

/** A recorded line answered again from its inputs. */
export function answerCompatAgain(registry: FacetRegistry, line: CompatLine): CompatLine {
  return lineOf(registry, line.key, decode(line.in))
}
