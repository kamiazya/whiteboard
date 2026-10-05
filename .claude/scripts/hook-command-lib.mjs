// What the PR hooks share about reading the tool call they were handed.
//
// A pull request is created, merged or edited in three shapes, and a hook that
// recognises one of them is a gate with a door beside it:
//
// - `gh pr create|merge|edit` — GraphQL-backed, so it answers HTTP 403 in a
//   Claude Code web session;
// - the REST call those commands stand for, `gh api -X POST …/pulls`,
//   `-X PUT …/pulls/<n>/merge`, `-X PATCH …/pulls/<n>` — what a web session
//   runs instead;
// - a GitHub MCP tool call (`create_pull_request`, `merge_pull_request`,
//   `update_pull_request`), which carries fields instead of a command string
//   and reaches a hook only through a matcher naming the tool.
//
// `prActionFromHookInput` reads all three into one `PrAction`, so each hook
// judges the action once whichever shape asked for it.
//
// A hook that matches the bare text of a command fires on `git commit -m 'note:
// gh pr merge 2029 later'` and `printf 'gh pr create …'`, neither of which does
// what the hook guards, and a gate that fires on something harmless is one
// people route around. So a command is matched where a command can START: the
// beginning of the text, or after a separator, optionally behind `VAR=value`
// assignments.
//
// A command's own words — a body, a REST call's fields — are read by
// `shellWords`, which removes quotes the way the shell does (`'…'`, `"…"`,
// `$'…'`, a backslash escape) but expands nothing.
//
// Known ceilings: FINDING a command is still a regex, so a separator inside a
// quoted string (`echo 'a; gh pr merge 1'`) still reads as a command
// position, and a PR made by `curl` against the API is not recognised. Every
// hook here is a one-time block or a fail-safe, so the cost of that first
// miss is a single unnecessary prompt.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const COMMAND_POSITION = String.raw`(?:^|[\n;]|&&|\|\||\|)\s*(?:[A-Za-z_]\w*=\S*\s+)*`

/** @param {string} words e.g. `gh pr merge`; spaces match any whitespace. */
function commandPattern(words, after = String.raw`\b`, flags = '') {
  return new RegExp(
    `${COMMAND_POSITION}${words.trim().split(/\s+/).join(String.raw`\s+`)}${after}`,
    flags,
  )
}

/**
 * @typedef {{ text: string } | { unreadable: string } | null} PrBody
 *   `null` is the `gh pr create` form with no body a hook can see (an editor,
 *   `--fill`, stdin) — the one case a hook lets through unread. That form only
 *   works where GraphQL does, a local session with the body in front of the
 *   person typing; `{ unreadable }` is a REST body nothing here could read.
 *
 * @typedef {object} PrAction
 * @property {'create' | 'merge' | 'edit'} action
 * @property {'gh-pr' | 'rest' | 'mcp'} form which of the three shapes carried it
 * @property {string} via        the form, as a message names it
 * @property {number | null} pr  null for a create, and for `gh pr merge` with no number
 * @property {string} repo       `owner/name`, or gh's `{owner}/{repo}`, which `gh api` resolves from the checkout
 * @property {string | null} head the branch a create publishes, owner prefix dropped
 * @property {PrBody} body
 * @property {string | null} cd  where a leading `cd` moved the command
 */

const PLACEHOLDER_REPO = '{owner}/{repo}'

/**
 * The PR action a hook's input carries, or null when it carries none.
 *
 * @param {unknown} input the hook JSON: `{ tool_name, tool_input }`
 * @param {{ cwd?: string, action?: PrAction['action'] }} [options]
 *   `cwd`: where a relative body file is read from, absent a leading `cd`.
 *   `action`: the one action the caller guards, so `gh pr create … && gh pr
 *   merge 5` answers the merge hook with the merge rather than the create.
 * @returns {PrAction | null}
 */
export function prActionFromHookInput(input, { cwd = process.cwd(), action } = {}) {
  const toolName = String(input?.tool_name ?? '')
  const toolInput = input?.tool_input ?? {}
  const mcp = /^mcp__.+__(create|merge|update)_pull_request$/.exec(toolName)
  if (mcp) {
    const found = fromMcp(mcp[1], toolName, toolInput)
    return action === undefined || found.action === action ? found : null
  }
  const command = typeof toolInput.command === 'string' ? toolInput.command : ''
  const wanted = (verb) => action === undefined || verb === action
  return fromGhPr(command, cwd, wanted) ?? fromRest(command, cwd, wanted)
}

const MCP_ACTIONS = { create: 'create', merge: 'merge', update: 'edit' }

function fromMcp(verb, toolName, fields) {
  const pr = Number(fields.pullNumber)
  return {
    action: MCP_ACTIONS[verb],
    form: 'mcp',
    via: `\`${toolName}\``,
    pr: Number.isInteger(pr) && pr > 0 ? pr : null,
    repo: fields.owner && fields.repo ? `${fields.owner}/${fields.repo}` : PLACEHOLDER_REPO,
    head: branchOf(fields.head),
    body: { text: typeof fields.body === 'string' ? fields.body : '' },
    cd: null,
  }
}

/** `owner:branch` names a fork's branch; the hooks only ever compare the branch. */
function branchOf(head) {
  if (typeof head !== 'string' || head === '') return null
  return head.slice(head.indexOf(':') + 1)
}

function leadingCd(command) {
  return command.match(/(?:^|&&|;)\s*cd\s+([^\s'";&|]+)/)?.[1] ?? null
}

const GH_PR_VERBS = ['create', 'merge', 'edit']

function fromGhPr(command, cwd, wanted) {
  const verb = GH_PR_VERBS.find((v) => wanted(v) && commandPattern(`gh pr ${v}`).test(command))
  if (verb === undefined) return null
  const at = commandPattern(`gh pr ${verb}`).exec(command)
  const { words } = shellWords(command.slice(at.index + at[0].length))
  const pr = commandPattern(`gh pr ${verb}`, String.raw`\s+(\d+)\b`).exec(command)
  const cd = leadingCd(command)
  return {
    action: verb,
    form: 'gh-pr',
    via: `\`gh pr ${verb}\``,
    pr: verb === 'create' || !pr ? null : Number(pr[1]),
    repo: PLACEHOLDER_REPO,
    head: branchOf(flagValue(words, '--head', '-H')),
    body: ghPrBody(words, cd ?? cwd),
    cd,
  }
}

/**
 * The value of one gh flag in every spelling gh's flag parser accepts —
 * `--long v`, `--long=v`, `-s v`, `-sv`, `-s=v` — the last occurrence winning,
 * as it does in gh. `words` are one gh pr command's, already unquoted by
 * `shellWords`, so every quoting a reader can type (`$'…'`, `a\ b`, `"x"'y'`)
 * reaches the hook as the text gh receives.
 *
 * ponytail: knows only the flag it is asked about, so another flag's value
 * spelled like this one (`--title -bx`) reads as this one, and combined
 * shorthands (`-db x`) are not split; a per-verb table of gh's flags is the
 * upgrade if either is ever typed.
 */
function flagValue(words, long, short) {
  let found
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === long || word === short) found = words[++i]
    else if (word.startsWith(`${long}=`)) found = word.slice(long.length + 1)
    else if (word.startsWith(short) && word.length > short.length) {
      found = word.slice(short.length).replace(/^=/, '')
    }
  }
  return found
}

/**
 * Reads the body (`--body`/`-b`) or body file (`--body-file`/`-F`) off one gh pr command's words;
 * a file, when one is named, is what gets read.
 */
function ghPrBody(words, where) {
  const path = flagValue(words, '--body-file', '-F')
  if (path !== undefined) {
    try {
      return { text: readFileSync(resolve(where, path), 'utf8') }
    } catch {
      return null
    }
  }
  const text = flagValue(words, '--body', '-b')
  return text === undefined ? null : { text }
}

/** gh api flags that take a value, so the value is not mistaken for the endpoint. */
const VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-H',
  '--header',
  '--input',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--hostname',
  '-p',
  '--preview',
  '--cache',
])

const PULLS_ENDPOINT =
  /^(?:https?:\/\/[^/]+\/(?:api\/v3\/)?)?\/?repos\/([^/?\s]+\/[^/?\s]+)\/pulls(?:\/(\d+)(\/merge)?)?\/?(?:\?.*)?$/

function fromRest(command, cwd, wanted) {
  for (const match of command.matchAll(commandPattern('gh api', String.raw`\s`, 'g'))) {
    const found = restCall(command, command.slice(match.index + match[0].length), cwd)
    if (found !== null && wanted(found.action)) return found
  }
  return null
}

/** One `gh api` call, read from the text after `gh api`, as a PR action or null. */
function restCall(command, rest, cwd) {
  const { words, stdin } = shellWords(rest)
  const call = parseGhApi(words)
  const target = PULLS_ENDPOINT.exec(call.endpoint ?? '')
  if (!target) return null
  const [, repo, number, merge] = target
  const action = restAction(call.method, number, merge)
  if (action === null) return null
  const cd = leadingCd(command)
  const request = restRequest(call, stdin, cd ?? cwd)
  return {
    action,
    form: 'rest',
    via: `\`gh api -X ${call.method} ${call.endpoint}\``,
    pr: number ? Number(number) : null,
    repo,
    head: branchOf(request.head),
    body: request.body,
    cd,
  }
}

/** Which PR action a method on `…/pulls[/<n>[/merge]]` is; a read is none. */
function restAction(method, number, merge) {
  if (method === 'POST' && !number) return 'create'
  if (method === 'PUT' && merge) return 'merge'
  if (method === 'PATCH' && number && !merge) return 'edit'
  return null
}

/** `-f`/`--raw-field` send a string as written; `-F`/`--field` read `@file`. */
const FIELD_FLAGS = new Map([
  ['-f', true],
  ['--raw-field', true],
  ['-F', false],
  ['--field', false],
])

/** `--flag=value` and `-Xvalue` carry their value in the word itself. */
function splitFlag(word) {
  if (word.startsWith('--') && word.includes('=')) {
    const eq = word.indexOf('=')
    return { flag: word.slice(0, eq), value: word.slice(eq + 1) }
  }
  if (/^-[XfFHqtp]./.test(word)) return { flag: word.slice(0, 2), value: word.slice(2) }
  return { flag: word, value: undefined }
}

function applyFlag(call, flag, value) {
  if (flag === '-X' || flag === '--method') call.method = value.toUpperCase()
  else if (flag === '--input') call.input = value
  else if (FIELD_FLAGS.has(flag) && value.indexOf('=') > 0) {
    const eq = value.indexOf('=')
    call.fields.set(value.slice(0, eq), { value: value.slice(eq + 1), raw: FIELD_FLAGS.get(flag) })
  }
}

/** The method, endpoint, fields and `--input` of one `gh api` call's words. */
function parseGhApi(words) {
  const call = { method: null, endpoint: null, input: null, fields: new Map() }
  for (let i = 0; i < words.length; i++) {
    const { flag, value: attached } = splitFlag(words[i])
    if (!VALUE_FLAGS.has(flag)) {
      if (!flag.startsWith('-')) call.endpoint ??= flag
      continue
    }
    const value = attached ?? words[++i]
    if (value === undefined) break
    applyFlag(call, flag, value)
  }
  // gh api's own default: GET, unless the call sends parameters.
  call.method ??= call.fields.size > 0 || call.input !== null ? 'POST' : 'GET'
  return call
}

/** What a REST call sends as `head` and `body`, read the way `gh api` would read them. */
function restRequest(call, stdin, where) {
  const readText = (source) => {
    if (source === '-') {
      return stdin === null
        ? { unreadable: 'it arrives on stdin from another command' }
        : { text: stdin }
    }
    try {
      return { text: readFileSync(resolve(where, source), 'utf8') }
    } catch {
      return { unreadable: `${source} could not be read` }
    }
  }
  if (call.input !== null) {
    const json = readText(call.input)
    if (!('text' in json)) return { head: null, body: json }
    try {
      const sent = JSON.parse(json.text)
      return { head: sent?.head ?? null, body: { text: String(sent?.body ?? '') } }
    } catch {
      return { head: null, body: { unreadable: `--input ${call.input} is not JSON` } }
    }
  }
  const head = call.fields.get('head')?.value ?? null
  const field = call.fields.get('body')
  if (!field) return { head, body: { text: '' } }
  if (!field.raw && field.value.startsWith('@'))
    return { head, body: readText(field.value.slice(1)) }
  return { head, body: { text: field.value } }
}

/**
 * The words of one simple command, quotes removed, up to the first unquoted
 * separator — and its stdin when a heredoc in the text supplies it.
 * Not a shell: no expansion, so `"$(cat x)"` stays those characters.
 */
function shellWords(text) {
  const words = []
  let word = null
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  let i = 0
  while (i < text.length && !SEPARATOR.test(text[i])) {
    if (text[i] === '<') {
      endWord()
      return { words, stdin: redirectedStdin(text.slice(i)) }
    }
    const piece = quotedPart(text, i) ?? plainPart(text, i)
    if (piece === null) endWord()
    else word = (word ?? '') + piece.part
    i = piece?.next ?? i + 1
  }
  endWord()
  return { words, stdin: null }
}

/** One unquoted character of a word, or null for the whitespace that ends one. */
function plainPart(text, i) {
  return /\s/.test(text[i]) ? null : { part: text[i], next: i + 1 }
}

const SEPARATOR = /[\n;&|>]/

/** The quoted or escaped piece starting at `i`, or null when none starts there. */
function quotedPart(text, i) {
  if (text[i] === "'") return untilQuote(text, i + 1, (part) => part)
  if (text[i] === '$' && text[i + 1] === "'") return untilQuote(text, i + 2, ansiC)
  if (text[i] === '"') return doubleQuoted(text, i + 1)
  if (text[i] === '\\' && i + 1 < text.length) {
    return { part: text[i + 1] === '\n' ? '' : text[i + 1], next: i + 2 }
  }
  return null
}

function untilQuote(text, start, decode) {
  const end = text.indexOf("'", start)
  if (end === -1) return { part: decode(text.slice(start)), next: text.length }
  return { part: decode(text.slice(start, end)), next: end + 1 }
}

/** Inside double quotes a backslash escapes only `"`, `\`, `$` and a backtick. */
function doubleQuoted(text, start) {
  let j = start
  let part = ''
  while (j < text.length && text[j] !== '"') {
    if (text[j] === '\\' && j + 1 < text.length && '"\\$`'.includes(text[j + 1])) j++
    part += text[j]
    j++
  }
  return { part, next: j + 1 }
}

const ANSI_C = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }

function ansiC(text) {
  return text.replace(/\\(.)/g, (whole, c) => ANSI_C[c] ?? whole)
}

/** A heredoc's text, or null for anything else (`<<<`, `< file`, a process substitution). */
function redirectedStdin(text) {
  const heredoc = /^<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)(?:^|\n)\t*\2[ \t]*(?:\n|$)/.exec(text)
  return heredoc ? heredoc[3] : null
}

/** True when `command` runs `git push`, allowing `git -C <dir>` / `-c k=v` / `--flag` before it. */
export function runsGitPush(command) {
  return new RegExp(
    `${COMMAND_POSITION}git\\s+(?:(?:-[Cc]\\s+\\S+|--[\\w-]+(?:=\\S+)?)\\s+)*push\\b`,
  ).test(command)
}
