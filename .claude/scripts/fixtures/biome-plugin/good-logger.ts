// Fixture: the correct pino order, plus the two shapes the rule must NOT
// flag — a bare message, and a real printf call whose placeholder makes the
// second argument an interpolation argument on purpose.
declare const log: Record<string, (...args: unknown[]) => void>
declare const workspaceId: string
declare const err: unknown

export function right(): void {
  log.warning({ workspaceId, err }, 'skipped corrupt row')
  log.notice('no auth token provided; admission disabled')
  log.info('resolved %s', workspaceId)
}
