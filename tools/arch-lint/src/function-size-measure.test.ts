import { describe, expect, it } from 'vitest'
import { measureSource } from './function-size-measure.js'

/** A body of `n` statements, so a fixture function's line count is the number it is asserted at. */
const body = (n: number): string =>
  Array.from({ length: n }, (_, i) => `  void ${String(i)}`).join('\n')

function linesByKey(source: string, path = 'fixture.tsx'): Record<string, number> {
  return Object.fromEntries(measureSource(source, path).map((row) => [row.key, row.lines]))
}

describe('measureSource names every shape a function takes in this repo', () => {
  it('measures a declaration, a variable-bound arrow and a variable-bound function expression', () => {
    const measured = linesByKey(
      [
        `function declared() {\n${body(3)}\n}`,
        `const arrow = () => {\n${body(4)}\n}`,
        `const expression = function () {\n${body(5)}\n}`,
      ].join('\n'),
    )

    expect(measured).toEqual({
      'fixture.tsx#declared': 5,
      'fixture.tsx#arrow': 6,
      'fixture.tsx#expression': 7,
    })
  })

  it('measures a named function expression handed to forwardRef under its own name', () => {
    const measured = linesByKey(
      `export const Editor = forwardRef<Handle, Props>(\n  function Editor(props, ref) {\n${body(60)}\n  },\n)`,
    )

    expect(measured['fixture.tsx#Editor']).toBe(62)
  })

  it('measures a named function expression wherever it appears', () => {
    const measured = linesByKey(
      `function host() {\n  list.forEach(function walk() {\n${body(3)}\n  })\n}`,
    )

    expect(Object.keys(measured)).toEqual(['fixture.tsx#host', 'fixture.tsx#host.walk'])
  })

  it('measures a named function expression handed to memo', () => {
    expect(linesByKey(`const Row = memo(function Row() {\n${body(55)}\n})`)).toEqual({
      'fixture.tsx#Row': 57,
    })
  })

  it('measures a module-level anonymous callback under the variable its call initialises', () => {
    const measured = linesByKey(
      [
        `export const plugin = ViewPlugin.define((view) => {\n${body(60)}\n})`,
        `const Wrapped = memo((props) => {\n${body(10)}\n})`,
        `const Casted = forwardRef((props, ref) => {\n${body(10)}\n}) as unknown as Foo`,
      ].join('\n'),
    )

    expect(measured).toEqual({
      'fixture.tsx#plugin': 62,
      'fixture.tsx#Wrapped': 12,
      'fixture.tsx#Casted': 12,
    })
  })

  it('looks up through every type-only wrapper to the variable a callback call initialises', () => {
    const sources = [
      `const Parenthesised = (memo(() => {\n${body(10)}\n}))`,
      `const Satisfied = memo(() => {\n${body(10)}\n}) satisfies Foo`,
      `const Asserted = <Foo>memo(() => {\n${body(10)}\n})`,
      `const Bang = memo(() => {\n${body(10)}\n})!`,
    ]
    expect(Object.keys(linesByKey(sources.join('\n'), 'fixture.ts')).sort()).toEqual([
      'fixture.ts#Asserted',
      'fixture.ts#Bang',
      'fixture.ts#Parenthesised',
      'fixture.ts#Satisfied',
    ])
  })

  it('leaves a callback inside a function counted toward that function, not named', () => {
    const measured = linesByKey(
      `function Component() {\n  const onTap = useCallback(() => {\n${body(60)}\n  }, [])\n}`,
    )

    expect(Object.keys(measured)).toEqual(['fixture.tsx#Component'])
  })

  it('leaves a stub built inside a describe body to the test that holds it', () => {
    const measured = linesByKey(
      `describe('a', () => {\n  it('b', () => {\n    const fetchMock = vi.fn(() => {\n${body(60)}\n    })\n  })\n})`,
    )

    expect(measured).toEqual({})
  })

  it('measures an arrow held by a class property under the property name', () => {
    const measured = linesByKey(`class Session {\n  patch = (a: number) => {\n${body(60)}\n  }\n}`)

    expect(measured).toEqual({ 'fixture.tsx#patch': 62 })
  })

  it('qualifies a function nested in a wrapped component by that component', () => {
    const measured = linesByKey(
      `const Editor = forwardRef(function Editor() {\n  function inner() {\n${body(2)}\n  }\n})`,
    )

    expect(Object.keys(measured).sort()).toEqual(['fixture.tsx#Editor', 'fixture.tsx#Editor.inner'])
  })

  it('numbers a key that repeats within a file, in source order', () => {
    const measured = linesByKey(
      `describe('a', () => {\n  function run() {\n${body(1)}\n  }\n})\ndescribe('b', () => {\n  function run() {\n${body(2)}\n  }\n})`,
    )

    expect(Object.keys(measured)).toEqual(['fixture.tsx#run~1', 'fixture.tsx#run~2'])
  })

  it('flags a test file so its functions are ledgered apart', () => {
    expect(measureSource('function f() {}', 'a.test.ts')[0]?.isTest).toBe(true)
    expect(measureSource('function f() {}', 'a.ts')[0]?.isTest).toBe(false)
  })
})
