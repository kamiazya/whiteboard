/**
 * The RFC 5424 severities, least to most severe. The one list: mcp-server's
 * pino logger, its MCP `notifications/message` bridge and its config schema all
 * take their levels from here, since this package sits below them and a second
 * spelling is a level one side forwards and the other drops.
 *
 * A module of its own, exported as `./log-levels`, because the logger that
 * needs it sits under every CLI path and must not load this package's whole
 * graph to learn eight names.
 */
export const LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const

export type LogLevel = (typeof LOG_LEVELS)[number]
