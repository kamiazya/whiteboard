// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { taskLineNumbers, toggleTaskLine } from './task-toggle.js'

const taskLine = fc.record({
  quote: fc.constantFrom('', '> ', '>> '),
  indent: fc.constantFrom('', ' ', '  ', '    '),
  marker: fc.constantFrom('-', '*', '+', '1.', '12)'),
  gap: fc.constantFrom(' ', '  '),
  done: fc.boolean(),
  text: fc.constantFrom('', 'ship it', 'a [b] c', '[x] inside'),
})
type TaskLine = {
  quote: string
  indent: string
  marker: string
  gap: string
  done: boolean
  text: string
}
const render = (t: TaskLine, done = t.done) =>
  `${t.quote}${t.indent}${t.marker}${t.gap}[${done ? 'x' : ' '}] ${t.text}`

describe('toggleTaskLine', () => {
  it('flips an unticked item and a ticked one, keeping marker and indentation', () => {
    expect(toggleTaskLine('- [ ] a', 1)).toBe('- [x] a')
    expect(toggleTaskLine('  * [x] a', 1)).toBe('  * [ ] a')
    expect(toggleTaskLine('+ [X] a', 1)).toBe('+ [ ] a')
  })

  it('touches only the addressed line of a nested list', () => {
    const source = '- [ ] top\n  - [ ] child\n  - [x] other\n'
    expect(toggleTaskLine(source, 2)).toBe('- [ ] top\n  - [x] child\n  - [x] other\n')
  })

  it('leaves CRLF line endings alone', () => {
    expect(toggleTaskLine('- [ ] a\r\n- [ ] b\r\n', 2)).toBe('- [ ] a\r\n- [x] b\r\n')
  })

  it('answers the source unchanged for a line that is not a task item', () => {
    const source = '# h\n- plain\n[ ] not a list\n'
    for (const line of [0, 1, 2, 3, 99]) expect(toggleTaskLine(source, line)).toBe(source)
  })

  fcTest.prop([fc.array(taskLine, { minLength: 1, maxLength: 8 }), fc.nat()], withDefaults())(
    'toggling the same line twice is the identity, and one toggle changes exactly that box',
    (lines, pick) => {
      const source = lines.map((t) => render(t)).join('\n')
      const index = pick % lines.length
      const once = toggleTaskLine(source, index + 1)
      expect(once.split('\n')).toEqual(
        lines.map((t, i) => (i === index ? render(t, !t.done) : render(t))),
      )
      expect(toggleTaskLine(once, index + 1)).toBe(source)
    },
  )
})

describe('taskLineNumbers', () => {
  it('lists task items in source order, skipping fenced code', () => {
    const source = ['- [ ] a', '```', '- [ ] in fence', '```', '  - [x] b', '- plain'].join('\n')
    expect(taskLineNumbers(source)).toEqual([1, 5])
  })

  it('agrees with the lines toggleTaskLine accepts', () => {
    const source = '- [ ] a\n\ntext\n1. [x] b\n'
    expect(taskLineNumbers(source)).toEqual([1, 4])
  })
})
