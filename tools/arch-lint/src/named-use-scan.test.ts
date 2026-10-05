import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'

const REALPATH = ['realpath', 'realpathSync']
const WRITE = ['writeSpatialCanvas', 'writeSpatialCanvasInto']

describe('countNamedUses reads uses of a name, not its text', () => {
  it.each([
    ['a bare call', 'const p = realpathSync(target)', REALPATH, 1],
    ['an awaited member call', 'const p = await fs.realpath(target)', REALPATH, 1],
    ['the native variant', 'const p = fs.realpathSync.native(target)', REALPATH, 1],
    ['a bracket access', "const p = await fsp['realpath'](target)", REALPATH, 1],
    [
      'an aliased import and its call',
      "import { realpath as rp } from 'node:fs/promises'\nconst p = await rp(target)",
      REALPATH,
      1,
    ],
    [
      'an aliased destructure and its call',
      'const { realpath: rp } = fsp\nawait rp(target)',
      REALPATH,
      1,
    ],
    [
      'an aliased resync import',
      "import { writeSpatialCanvas as save } from 'x'\nsave(doc, next)",
      WRITE,
      1,
    ],
    ['a bracket access on a bridge', "bridge['writeSpatialCanvasInto'](doc, next)", WRITE, 1],
    ['a reference passed along without a call', 'run(writeSpatialCanvas)', WRITE, 1],
    ['a plain import, which is no use', "import { realpath } from 'node:fs/promises'", REALPATH, 0],
    ['a comment', '// realpath(target) in a comment', REALPATH, 0],
    ['a string', "log.warn('writeSpatialCanvas(doc, next)')", WRITE, 0],
    ['a neighbour name', 'realpathNearestExisting(target)', REALPATH, 0],
    ['a sibling resync', 'reconcileSpatialCanvas(doc, prev, next)', WRITE, 0],
    ['a declaration of its own', 'function realpath() {}', REALPATH, 0],
    ['an object key', 'const x = { realpath: 1 }', REALPATH, 0],
  ])('%s', (_label, source, names, expected) => {
    expect(countNamedUses('fixture.ts', source, names)).toBe(expected)
  })
})

// A file whose text never spells a wanted name is answered without a parse, so these are the
// spellings that reach a name through an escape instead — each must still count.
describe('countNamedUses counts a name an escape spells', () => {
  it.each([
    ['a unicode escape in an identifier', 'const p = re\\u0061lpath(target)', REALPATH, 1],
    ['a hex escape in a string key', "await fsp['re\\x61lpath'](target)", REALPATH, 1],
    ['an identity escape in a string key', "bridge['writeSpatial\\Canvas'](doc)", WRITE, 1],
    ['a line continuation in a string key', "bridge['writeSpatial\\\nCanvas'](doc)", WRITE, 1],
    [
      'an escaped key in an aliased import',
      "import { re\\u0061lpath as rp } from 'x'\nrp(t)",
      REALPATH,
      1,
    ],
  ])('%s', (_label, source, names, expected) => {
    expect(countNamedUses('fixture.ts', source, names)).toBe(expected)
  })

  it('answers a source that spells nothing it wants without counting anything', () => {
    expect(countNamedUses('fixture.ts', 'const p = other(target)', REALPATH)).toBe(0)
    expect(countNamedUses('fixture.ts', 'const p = other(target', REALPATH)).toBe(0)
  })
})
