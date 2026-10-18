import type {
  Code,
  Construct,
  Extension,
  State,
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

const ASTERISK = 42
const RIGHT_SQUARE_BRACKET = 93
const UNDERSCORE = 95
const TILDE = 126

type Account = { spent: number; exhausted: boolean }

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
    account = { spent: 0, exhausted: false }
    accounts.set(context.sliceSerialize, account)
  }
  return account
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
  const account = accountOf(this)
  const before = this.previous
  let marker: Code = null
  let size = 0
  return start

  function start(code: Code): State | undefined {
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
      if (account.spent + size <= DELIMITER_BUDGET) {
        account.spent += size
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
