// What the Bash hooks share about reading the command they were handed.
//
// A hook that matches the bare text of a command fires on `git commit -m 'note:
// gh pr merge 2029 later'` and `printf 'gh pr create …'`, neither of which does
// what the hook guards, and a gate that fires on something harmless is one
// people route around. So a command is matched where a command can START: the
// beginning of the text, or after a separator, optionally behind `VAR=value`
// assignments.
//
// Known ceiling: a separator inside a quoted string (`echo 'a; gh pr merge 1'`)
// still reads as a command position. Telling quotes from separators needs a
// shell parser, and every hook here fails open or is a one-time block, so the
// cost of that miss is a single unnecessary prompt.

const COMMAND_POSITION = String.raw`(?:^|[\n;]|&&|\|\||\|)\s*(?:[A-Za-z_]\w*=\S*\s+)*`

/** @param {string} words e.g. `gh pr merge`; spaces match any whitespace. */
function commandPattern(words, after = String.raw`\b`) {
  return new RegExp(`${COMMAND_POSITION}${words.trim().split(/\s+/).join(String.raw`\s+`)}${after}`)
}

/** True when `command` runs `gh <subcommand>` (`pr merge`, `pr create`) as a command. */
export function runsGh(command, subcommand) {
  return commandPattern(`gh ${subcommand}`).test(command)
}

/** `gh pr merge 1234 ...` -> 1234; a bare `gh pr merge` -> null (use the branch's PR). */
export function prNumberFromMerge(command) {
  const match = commandPattern('gh pr merge', String.raw`\s+(\d+)\b`).exec(command)
  return match ? Number(match[1]) : null
}

/** True when `command` runs `git push`, allowing `git -C <dir>` / `-c k=v` / `--flag` before it. */
export function runsGitPush(command) {
  return new RegExp(
    `${COMMAND_POSITION}git\\s+(?:(?:-[Cc]\\s+\\S+|--[\\w-]+(?:=\\S+)?)\\s+)*push\\b`,
  ).test(command)
}
