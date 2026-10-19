import type {
  Code,
  Construct,
  Extension,
  State,
  Token,
  TokenizeContext,
  Tokenizer,
} from 'micromark-util-types'

/**
 * Delimiter characters one inline run — a paragraph, a heading, a table
 * cell — may hand to emphasis, strikethrough and link resolution.
 *
 * micromark resolves those by walking back from each closing delimiter over
 * everything before it, and re-resolves the span between each matched pair,
 * so its cost is the number of delimiters times the length of the run. That
 * is quadratic for a run made of nothing else: `a* ` repeated 8,000 times
 * (24 KB) takes seconds, and the 256 KB a body may hold, minutes. Capping the
 * delimiters bounds the cost at this number times the run's length, linear
 * in the body. A paragraph needs 256 bold phrases before it reaches the cap;
 * past it, its remaining delimiters read as the characters they are.
 */
const DELIMITER_BUDGET = 1024

/**
 * Events the walks back from one run's delimiters may pass over in all.
 *
 * The delimiter cap alone bounds the walks at 1,024 times the run, and a run
 * can hold far more events than characters of prose: an escape writes six.
 * 1,024 unmatched closers after 256 KB of `\*` took 17 s (`a]`: 33 s). So
 * each delimiter is also charged the walk it can cause, and this caps the
 * total — at about 20 ms of walking. An emphasis or strikethrough closer may
 * walk back to the start of the run, which flanking rules and earlier matches
 * decide only at resolution, so it is charged its whole position. A label end
 * walks back to the nearest label start still open, which the account tracks
 * (`LabelStarts`), so a paragraph of `[[a]]` references pays almost nothing.
 */
const WALK_BUDGET = 2 ** 20

const ASTERISK = 42
const RIGHT_SQUARE_BRACKET = 93
const UNDERSCORE = 95
const TILDE = 126

/**
 * Label starts a label end may still close, in event order, and how far the
 * events have been read for new ones. A start that is balanced stays
 * balanced, and a link that forms rewrites the events from its start on, so
 * entries leave from the top and a stale one sends the read back to it.
 */
type LabelStarts = { open: { index: number; token: Token }[]; read: number }

type Account = { spent: number; walked: number; exhausted: boolean; labels: LabelStarts }

/**
 * Keyed by the tokenizer's own `sliceSerialize`: micromark creates one text
 * tokenizer per inline run and that function per tokenizer, and it is the
 * same function when a construct runs on a context derived from it. The
 * events array is no key — a link's resolver replaces it mid-run.
 */
const accounts = new WeakMap<TokenizeContext['sliceSerialize'], Account>()

function accountOf(context: TokenizeContext): Account {
  let account = accounts.get(context.sliceSerialize)
  if (account === undefined) {
    account = { spent: 0, walked: 0, exhausted: false, labels: { open: [], read: 0 } }
    accounts.set(context.sliceSerialize, account)
  }
  return account
}

function isLabelStart(event: TokenizeContext['events'][number]): boolean {
  return event[0] === 'enter' && (event[1].type === 'labelLink' || event[1].type === 'labelImage')
}

/**
 * How far back a label end at the end of `events` walks: to the nearest
 * label start not yet balanced, as micromark's own walk looks for, or to the
 * start of the run.
 */
function labelEndWalk(labels: LabelStarts, events: TokenizeContext['events']): number {
  const { open } = labels
  const settle = () => {
    for (let top = open.at(-1); top !== undefined; top = open.at(-1)) {
      if (events[top.index]?.[1] !== top.token) {
        labels.read = Math.min(labels.read, top.index)
      } else if (!top.token._balanced) {
        return
      }
      open.pop()
    }
  }
  settle()
  labels.read = Math.min(labels.read, events.length)
  for (; labels.read < events.length; labels.read++) {
    const event = events[labels.read]
    if (event !== undefined && isLabelStart(event)) {
      open.push({ index: labels.read, token: event[1] })
    }
  }
  settle()
  return events.length - (open.at(-1)?.index ?? 0)
}

/** Events a delimiter of `marker` at the end of `events` may walk back over. */
function walkOf(marker: Code, account: Account, events: TokenizeContext['events']): number {
  return marker === RIGHT_SQUARE_BRACKET ? labelEndWalk(account.labels, events) : events.length
}

/** Neither whitespace nor punctuation, by micromark's own classification. */
function isWordCharacter(code: Code): boolean {
  if (code === null || code < 0) return false
  const character = String.fromCodePoint(code)
  return !/\s/u.test(character) && !/[\p{P}\p{S}]/u.test(character)
}

/**
 * An underscore between two word characters can neither open nor close
 * (`snake_case`), so it costs the resolver nothing and is not charged.
 */
function isInert(marker: Code, before: Code, after: Code): boolean {
  return marker === UNDERSCORE && isWordCharacter(before) && isWordCharacter(after)
}

/**
 * Runs before emphasis, strikethrough and label ends at their delimiter. It
 * declines (`nok`) while the run's account has room, so the real construct
 * reads the delimiter exactly as it would have; once the account is spent it
 * takes the delimiter itself, as plain data, for the rest of the run.
 */
const tokenizeDelimiterBudget: Tokenizer = function (effects, ok, nok) {
  const self = this
  const account = accountOf(this)
  const before = this.previous
  let marker: Code = null
  let size = 0
  return start

  function start(code: Code): State | undefined {
    // Strikethrough refuses a run of more than two tildes and leaves it to
    // data a character at a time, so this is tried again at every tilde of
    // the run; charged each time, a run of 46 spent the whole budget.
    if (code === TILDE && before === TILDE && self.events.at(-1)?.[1].type !== 'characterEscape') {
      return nok(code)
    }
    marker = code
    effects.enter('data')
    return inside(code)
  }

  function inside(code: Code): State | undefined {
    // A label end closes one `]` at a time, so each is accounted alone.
    if (code === marker && (marker !== RIGHT_SQUARE_BRACKET || size === 0)) {
      effects.consume(code)
      size += 1
      return inside
    }
    if (!account.exhausted) {
      if (isInert(marker, before, code)) return nok(code)
      const walk = walkOf(marker, account, self.events)
      if (account.spent + size <= DELIMITER_BUDGET && account.walked + walk <= WALK_BUDGET) {
        account.spent += size
        account.walked += walk
        return nok(code)
      }
      account.exhausted = true
    }
    effects.exit('data')
    return ok(code)
  }
}

const delimiterBudget: Construct = { name: 'delimiterBudget', tokenize: tokenizeDelimiterBudget }

/**
 * Must be registered after every extension that adds a construct on these
 * characters: micromark tries a later extension's constructs first.
 */
export const delimiterBudgetExtension: Extension = {
  text: {
    [ASTERISK]: delimiterBudget,
    [RIGHT_SQUARE_BRACKET]: delimiterBudget,
    [UNDERSCORE]: delimiterBudget,
    [TILDE]: delimiterBudget,
  },
}
