// The one parser every `whiteboard` subcommand's flags go through.
//
// It exists because the inline-only rule is a SECURITY rule, and it was
// re-implemented per subcommand: a value flag in the space form
// (`--flag <value>`) takes the NEXT token as its value, so a parser that
// forgets to refuse it swallows whatever follows — a token, a path. Six
// parsers each spelled that refusal out by hand, `--data-dir` five times
// between them, and nothing made them agree. Here a flag DECLARES its kind
// and the refusal follows from the kind.

/** A value flag's check, when the flag wants more than "not empty". */
export type FlagCheck = (value: string) => string | undefined

export interface FlagTable<Field extends string> {
  /** Set-once flags. A repeat is a usage error naming the flag. */
  readonly booleans: readonly string[]
  /** `--flag=<value>` only, each landing in the named field. */
  readonly values: Readonly<Record<string, Field>>
  /**
   * Flags accepted by the grammar only to be REFUSED, with the message
   * saying what to use instead — `--token`, whose value must never reach an
   * error message.
   */
  readonly rejected?: Readonly<Record<string, string>>
  /**
   * Per-flag validation, run in place of the empty-value check so the flag
   * owns its whole message. Runs INSIDE the scan, so an invalid value is
   * reported before a later unknown argument — the order the hand-written
   * parsers had.
   */
  readonly checks?: Readonly<Record<string, FlagCheck>>
}

export type FlagScan<Field extends string> =
  | { kind: 'ok'; seen: ReadonlySet<string>; values: Readonly<Partial<Record<Field, string>>> }
  | { kind: 'usage-error'; message: string }

/**
 * Never echoes a raw value: an argument that is not a flag is reported as a
 * placeholder, and a flag's value is elided. A usage error is the one place
 * a mistyped token most easily lands.
 */
export function redactFlagValue(arg: string): string {
  if (!arg.startsWith('--')) return '[REDACTED_ARGUMENT]'
  const eq = arg.indexOf('=')
  if (eq === -1) return arg
  return `${arg.slice(0, eq)}=…`
}

/**
 * Membership is asked of a Set, never with `in` or a property read: both
 * walk the prototype chain, so `'toString'` answers true for any object
 * literal. That made `whiteboard server run toString` report "toString
 * requires the inline form" — and echo the raw argument, which is the one
 * thing this module never does. Found by differential-testing the first of
 * these rewrites against the blocks it replaced, not by reading it.
 */
function namesOf(table: Readonly<Record<string, unknown>> | undefined): ReadonlySet<string> {
  return new Set(Object.keys(table ?? {}))
}

export function scanFlags<Field extends string>(
  args: readonly string[],
  table: FlagTable<Field>,
): FlagScan<Field> {
  const booleans = new Set(table.booleans)
  const valueNames = namesOf(table.values)
  const rejectedNames = namesOf(table.rejected)

  const seen = new Set<string>()
  const values: Partial<Record<Field, string>> = {}
  const usageError = (message: string): FlagScan<Field> => ({ kind: 'usage-error', message })

  for (const arg of args) {
    if (booleans.has(arg)) {
      if (seen.has(arg)) return usageError(`${arg} specified more than once`)
      seen.add(arg)
      continue
    }

    // Both forms of a rejected flag, so `--token=secret` is refused by the
    // flag rather than falling through to "unknown argument" — which would
    // be correct and useless.
    const rejected = [...rejectedNames].find((name) => arg === name || arg.startsWith(`${name}=`))
    if (rejected !== undefined) return usageError(table.rejected?.[rejected] as string)

    if (valueNames.has(arg)) {
      return usageError(`${arg} requires the inline form: ${arg}=<value>`)
    }

    const flag = [...valueNames].find((name) => arg.startsWith(`${name}=`))
    if (flag !== undefined) {
      const value = arg.slice(flag.length + 1)
      const check = Object.hasOwn(table.checks ?? {}, flag) ? table.checks?.[flag] : undefined
      const failure = check === undefined ? emptyCheck(flag, value) : check(value)
      if (failure !== undefined) return usageError(failure)
      const field = table.values[flag] as Field
      if (values[field] !== undefined) return usageError(`${flag} specified more than once`)
      values[field] = value
      continue
    }

    return usageError(`Unknown argument: ${redactFlagValue(arg)}`)
  }

  return { kind: 'ok', seen, values }
}

function emptyCheck(flag: string, value: string): string | undefined {
  return value.length === 0 ? `${flag}=<value> requires a non-empty value` : undefined
}
