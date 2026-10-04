/**
 * A use of an export is judged by the declaration it binds to, not by the
 * spelling alone: two modules may export the same name (`LEDGER`,
 * `WORKSPACE_TREE_KEY`), and a scan by name lets a use of one excuse the other.
 * These fixtures pin the resolution `test-only-exports-scan.ts` does through
 * `module-exports-resolve.ts`: relative specifiers, barrels, workspace package
 * entries and namespace imports, and the conservative fallback to the name
 * where a binding cannot be placed.
 */
import { describe, expect, it } from 'vitest'
import { workspaceEntries } from './module-exports-resolve.js'
import { findTestOnlyExports } from './test-only-exports-scan.js'

describe('a name is judged by the module that declares it', () => {
  const one = 'packages/a/src/one.ts'
  const two = 'packages/a/src/two.ts'
  const body = 'export const shared = 1\nexport const own = shared\n'
  const entries = new Map([['@scope/a', 'packages/a/src/index.ts']])
  const foundWith = (files: Record<string, string>, specifiers = entries): string[] =>
    findTestOnlyExports(
      Object.entries(files).map(([path, text]) => ({ path, text })),
      specifiers,
    ).map(({ key }) => key)

  it('does not let a use of one same-named export excuse the other', () => {
    expect(
      foundWith({
        [one]: body,
        [two]: body,
        'packages/a/src/user.ts': "import { shared } from './two.js'\nexport const u = shared\n",
        'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
        'packages/a/src/two.test.ts': "import { shared } from './two.js'\n",
      }),
    ).toEqual([`${one}#shared`])
  })

  it('does not let a test of one same-named export make the other test-only', () => {
    expect(
      foundWith({
        [one]: body,
        [two]: body,
        'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
      }),
    ).toEqual([`${one}#shared`])
  })

  it('follows a name through a barrel and a package entry to where it is declared', () => {
    const files = {
      [one]: body,
      [two]: body,
      'packages/a/src/index.ts': "export * from './two.js'\n",
      'packages/b/src/user.ts': "import { shared } from '@scope/a'\nexport const u = shared\n",
      'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
      'packages/a/src/two.test.ts': "import { shared } from './two.js'\n",
    }
    expect(foundWith(files)).toEqual([`${one}#shared`])
    expect(
      foundWith({
        ...files,
        'packages/a/src/index.ts': "export { shared } from './two.js'\n",
      }),
    ).toEqual([`${one}#shared`])
  })

  it('follows a namespace import to the module it names', () => {
    expect(
      foundWith({
        [one]: body,
        [two]: body,
        'packages/a/src/user.ts': "import * as m from './two.js'\nexport const u = m.shared\n",
        'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
      }),
    ).toEqual([`${one}#shared`])
  })

  it('does not count a same-named local declaration, or an external import, as a use', () => {
    const files = {
      [one]: body,
      'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
    }
    expect(
      foundWith({
        ...files,
        'packages/a/src/local.ts': 'const shared = 2\nexport const l = shared\n',
      }),
    ).toEqual([`${one}#shared`])
    expect(
      foundWith({
        ...files,
        'packages/a/src/ext.ts': "import { shared } from 'some-package'\nexport const e = shared\n",
      }),
    ).toEqual([`${one}#shared`])
  })

  it('counts a member read off a dynamic import even where the file declares that name', () => {
    expect(
      foundWith({
        [one]: body,
        [two]: body,
        'packages/a/src/user.ts':
          "const shared = lazy(() => import('./one.js').then((m) => ({ default: m.shared })))\nexport const u = shared\n",
        'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
        'packages/a/src/two.test.ts': "import { shared } from './two.js'\n",
      }),
      // A property read is only known by its name, so it excuses both modules' exports.
    ).toEqual([])
  })

  it('follows a local re-export of an import and a directory index', () => {
    const files = {
      [one]: body,
      [two]: body,
      'packages/a/src/dir/index.ts': "import { shared } from '../two.js'\nexport { shared }\n",
      'packages/a/src/user.ts': "import { shared } from './dir'\nexport const u = shared\n",
      'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
      'packages/a/src/two.test.ts': "import { shared } from './two.js'\n",
    }
    expect(foundWith(files)).toEqual([`${one}#shared`])
  })

  it('reads a namespace member written as a type', () => {
    expect(
      foundWith({
        [one]: 'export type Shape = 1\nexport type Own = Shape\n',
        [two]: 'export type Shape = 2\nexport type Own = Shape\n',
        'packages/a/src/user.ts': "import type * as m from './two.js'\nexport type U = m.Shape\n",
        'packages/a/src/one.test.ts': "import type { Shape } from './one.js'\n",
      }),
    ).toEqual([`${one}#Shape`])
  })

  it('calls a name barrel-only through the module it forwards, not through a namesake', () => {
    const files = {
      [one]: body,
      [two]: body,
      'packages/a/src/index.ts': "export { shared } from './two.js'\n",
      'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
      'packages/a/src/two.test.ts': "import { shared } from './two.js'\n",
    }
    const classOf = (path: string): string | undefined =>
      findTestOnlyExports(Object.entries(files).map(([file, text]) => ({ path: file, text })))
        .filter((found) => found.path === path)
        .map((found) => found.class)[0]
    expect(classOf(two)).toBe('barrel-only')
    expect(classOf(one)).toBe('reached')
  })

  it('keeps a use through a barrel with a link it cannot follow as a use of the name', () => {
    expect(
      foundWith({
        [one]: body,
        'packages/a/src/index.ts': "export * from './elsewhere.js'\n",
        'packages/a/src/user.ts': "import { shared } from './index.js'\nexport const u = shared\n",
        'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
      }),
    ).toEqual([])
  })

  it('keeps a workspace specifier with no known entry as a use of the name', () => {
    expect(
      foundWith({
        [one]: body,
        'packages/b/src/user.ts':
          "import { shared } from '@kamiazya/whiteboard-unlisted'\nexport const u = shared\n",
        'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
      }),
    ).toEqual([])
  })

  it('reads a sibling test as importing a type it takes through a local re-export', () => {
    const files = {
      [one]: 'export type Shape = 1\nexport type Own = Shape\n',
      'packages/a/src/test-utils/index.ts':
        "import type { Shape } from '../one.js'\nexport type { Shape }\n",
      'packages/a/src/one.test.ts': "import type { Shape } from './test-utils/index.js'\n",
    }
    const classOf = findTestOnlyExports(
      Object.entries(files).map(([path, text]) => ({ path, text })),
    ).map((found) => found.class)
    expect(classOf).toEqual(['shape'])
  })

  it('keeps a use it cannot resolve to a module as a use of the name', () => {
    expect(
      foundWith({
        [one]: body,
        'packages/a/src/user.ts':
          "import { shared } from './elsewhere.js'\nexport const u = shared\n",
        'packages/a/src/one.test.ts': "import { shared } from './one.js'\n",
      }),
    ).toEqual([])
  })
})

describe('the workspace package entries', () => {
  it('reads where a workspace package specifier lands from its manifest', () => {
    const manifest = JSON.stringify({
      name: '@scope/a',
      exports: {
        '.': { types: './src/index.ts', import: './src/index.ts' },
        './sub': './src/sub.ts',
        './built': { import: './dist/built.js' },
        './pattern/*': './src/pattern/*.ts',
        './package.json': './package.json',
      },
    })
    expect(workspaceEntries([{ dir: 'packages/a', text: manifest }])).toEqual(
      new Map([
        ['@scope/a', 'packages/a/src/index.ts'],
        ['@scope/a/sub', 'packages/a/src/sub.ts'],
      ]),
    )
  })
})
