import type { Env, Handler, Hono } from 'hono'

export type WorkspaceScopedMethod = 'get' | 'post' | 'put' | 'delete' | 'patch'

type RoutableApp<E extends Env = Env> = Pick<Hono<E>, WorkspaceScopedMethod>

export function toWorkspacePath(sessionPath: string): string {
  return sessionPath.replace(/^\/api\/sessions\b/, '/api/workspaces')
}

export function registerWorkspaceAlias<E extends Env, P extends string>(
  app: RoutableApp<E>,
  method: WorkspaceScopedMethod,
  sessionPath: P,
  handler: Handler<E, P>,
): void {
  app[method](sessionPath, handler)
  app[method](toWorkspacePath(sessionPath) as P, handler)
}
