// Parse a release-gate-matrix command string into [cmd, ...args] for spawnSync
// WITHOUT a shell. Only plain whitespace-separated tokens are allowed: anything
// that would need shell interpretation (quotes, metacharacters, env assignment,
// glob, redirection, command substitution) is rejected, so a matrix command can
// never smuggle shell behavior into the non-shell runner.

// Shell metacharacters and quotes that a non-shell exec must never receive verbatim.
const SHELL_METACHAR = /[`$&|;<>(){}[\]*?!~"'\\]/
// Leading FOO=bar style environment assignment.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Split a gate command string into argv tokens, rejecting shell-unsafe input.
 * @param {string} command
 * @returns {string[]} non-empty argv, e.g. ['pnpm', '--filter', '@kamiazya/whiteboard-web', 'smoke:artifact']
 * @throws {Error} on empty input or any token needing shell interpretation
 */
export function splitCommand(command) {
  if (typeof command !== 'string') {
    throw new TypeError(`command must be a string, got ${typeof command}`)
  }
  const trimmed = command.trim()
  if (trimmed === '') {
    throw new Error('command must not be empty')
  }
  const tokens = trimmed.split(/\s+/)
  for (const token of tokens) {
    if (SHELL_METACHAR.test(token)) {
      throw new Error(
        `command token "${token}" contains a shell metacharacter; the runner executes without a shell`,
      )
    }
    if (ENV_ASSIGNMENT.test(token)) {
      throw new Error(
        `command token "${token}" looks like an env assignment; gate commands must be plain argv`,
      )
    }
  }
  return tokens
}
