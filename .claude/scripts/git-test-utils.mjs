// Git for a test's throwaway repository, isolated from whoever runs the test.
//
// A test that commits in a scratch repo runs the contributor's own git
// configuration unless told otherwise. Measured with `pnpm test:scripts`
// under a global config that is ordinary on a developer's machine:
// `commit.gpgsign=true` failed 71 of 512 tests ("gpg failed to sign the
// data"), `tag.gpgsign=true` turned seven more into skips with a premise
// message about biome, and a global `core.hooksPath` failed 29 — all green on
// a runner whose global config sets none of them.
//
// So the environment drops the global and system files outright rather than
// overriding the keys known to hurt today: the next harmful key is one nobody
// has measured yet. A repository-local `git config` still applies, which is
// what lets a test set `core.hooksPath` or `pull.rebase` on purpose.

/**
 * Variables that make git operate on another repository than its cwd says. A
 * caller inside a git hook has them exported, and a scratch repo would then
 * be the caller's own.
 */
const REPOSITORY_SELECTORS =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE)$/

/** `git -c` and `GIT_CONFIG_COUNT` settings a parent process passes down. */
const INHERITED_CONFIG = /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/

/**
 * Settings that hold whatever repository-local config a test writes, applied
 * with command-line precedence. Only keys no test here sets locally belong in
 * it, since these win over the repository's own file.
 */
const PINNED_CONFIG = [
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['push.negotiate', 'false'],
  // An explicit default branch also silences git's multi-line hint on every `git init`.
  ['init.defaultBranch', 'main'],
]

/**
 * The environment to run scratch-repo git in — and any script under test that
 * runs git itself, since it inherits it.
 *
 * @param {Record<string, string | undefined>} [extra] variables to add on top
 * @param {Record<string, string | undefined>} [base] the environment to start from
 * @returns {Record<string, string>}
 */
export function isolatedGitEnv(extra = {}, base = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || REPOSITORY_SELECTORS.test(key) || INHERITED_CONFIG.test(key))
      continue
    env[key] = value
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_COUNT: String(PINNED_CONFIG.length),
  })
  PINNED_CONFIG.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  return Object.assign(env, extra)
}
