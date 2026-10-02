// The usage text is where an operator learns which flags `server run` takes.
// The parser's flag table is the authority, so the text is held to it: a flag
// the parser accepts and the usage never names is one nobody finds.
import { describe, expect, it } from 'vitest'
import { USAGE } from './dispatcher.js'
import { SERVER_RUN_FLAGS } from './server-run-args.js'

const usageLine = (command: string) =>
  USAGE.split('\n').find((line) => line.startsWith(`whiteboard server ${command} `)) ?? ''

describe('the usage text names every flag the server run parser accepts', () => {
  const flags = [...Object.keys(SERVER_RUN_FLAGS.values), ...SERVER_RUN_FLAGS.booleans]

  it('reads a real flag table', () => {
    expect(flags.length).toBeGreaterThan(10)
    expect(flags).toContain('--jwt-clock-skew')
  })

  // `--dry-run` is what `run` does with a configuration it will not start; the
  // doctor reads the same flags and has no dry run to ask for.
  it.each([
    ['run', flags],
    ['doctor', flags.filter((flag) => flag !== '--dry-run')],
  ])('lists them all on the `server %s` line', (command, expected) => {
    const line = usageLine(command as string)
    expect(line).not.toBe('')
    expect((expected as string[]).filter((flag) => !line.includes(flag))).toEqual([])
  })
})
