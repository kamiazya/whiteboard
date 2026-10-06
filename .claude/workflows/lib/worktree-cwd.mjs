// What a phase agent is told when its workflow runs in a worktree. Copied inline into
// dev-loop.workflow.mjs and review.workflow.mjs (the workflow sandbox has no import);
// worktree-cwd.test.mjs holds the copies to this module.
//
// The command half is the part that matters: from the main checkout, a test path that names
// the worktree answers "No test files found", and a RELATIVE path quietly runs the main
// checkout's copy of the file — green, on code the lane never changed.

export function worktreeCwdNote(cwd) {
  if (!cwd) return ''
  return ` Work inside the worktree at ${cwd}: run git as \`git -C ${cwd} ...\`, create/edit files under that path (use absolute paths), and run every pnpm/vitest/node command as \`cd ${cwd} && …\` — from anywhere else a relative path runs the main checkout's copy of the file, green on code you never changed.`
}

export function worktreeCwdHint(cwd) {
  if (!cwd) return ''
  return ` All paths are under ${cwd}; run git as \`git -C ${cwd} ...\`, Read files at that absolute path, and run every pnpm/vitest/node command as \`cd ${cwd} && …\` — from anywhere else a relative path runs the main checkout's copy of the file.`
}
