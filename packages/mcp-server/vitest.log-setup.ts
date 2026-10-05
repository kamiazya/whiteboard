import { setStderrLogDestination } from './src/server/log.js'

/**
 * Keeps a passing run quiet: the suite drives refusals, corrupt rows and
 * thrown handlers on purpose, and each one logs a warning or an error. On
 * stderr those records read like a real setup problem ("widget HTML missing",
 * "refusing to start") in a run where every test passed.
 *
 * Only the default stderr destination is turned off. `captureLogsForTests` and
 * the MCP bridge still receive every record, and vitest's own failure output
 * is not a log record. A test that asserts on what reaches stderr opts back in
 * with `setStderrLogDestination(true)`.
 *
 * A setup file rather than an environment variable the logger reads, so
 * nothing a production process can be configured with mutes the daemon, and a
 * child process a test spawns keeps its stderr.
 */
setStderrLogDestination(false)
