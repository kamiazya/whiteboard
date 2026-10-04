// What a script that changes state needs at its entry: "known flags, or usage and exit", and
// whether it was run as the script rather than imported by a test.
//
// A script that reads its flags with `argv.includes('--dry-run')` treats everything it does not
// recognise as consent: `--help`, or a typo such as `--dryrun`, then runs the destructive default.
// Parsing against the declared set turns every unrecognised option into a refusal that names it.
//
// `--help` / `-h` print the usage on stdout and exit 0; any other unknown option, or more
// positionals than allowed, prints the usage on stderr and exits 2. A lone `-` is a positional
// (stdin by convention), not an option.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module at `moduleUrl` is the one node was started on. A script exports its helpers
 * for its test and runs `main()` only when this holds. Both paths are resolved so a symlinked
 * entry still counts.
 *
 * @param {string} moduleUrl the caller's `import.meta.url`
 */
export function isRunAsScript(moduleUrl) {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

/**
 * @param {{
 *   argv: string[], usage: string, flags?: string[], maxPositionals?: number,
 *   io?: { stdout?: (text: string) => void, stderr?: (text: string) => void, exit?: (code: number) => never },
 * }} input
 * @returns {{ flags: Set<string>, positionals: string[] }}
 */
export function parseScriptArgs({
  argv,
  usage,
  flags = [],
  maxPositionals = 0,
  io: {
    stdout = (text) => process.stdout.write(text),
    stderr = (text) => process.stderr.write(text),
    exit = (code) => process.exit(code),
  } = {},
}) {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    stdout(`${usage}\n`)
    return exit(0)
  }
  const known = new Set(flags)
  const seen = new Set()
  const positionals = []
  for (const arg of argv) {
    if (arg.startsWith('-') && arg !== '-') {
      if (!known.has(arg)) return refuse(`unknown option ${arg}`)
      seen.add(arg)
    } else {
      positionals.push(arg)
    }
  }
  if (positionals.length > maxPositionals) {
    return refuse(`unexpected argument ${positionals[maxPositionals]}`)
  }
  return { flags: seen, positionals }

  function refuse(reason) {
    stderr(`${reason}\n${usage}\n`)
    return exit(2)
  }
}
