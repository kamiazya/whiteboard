import { type OkfCodec, okfCodec } from '@kamiazya/whiteboard-codec'
import type { ServerDeps } from '../server-deps.js'

/** The OKF envelope as this server's deps say to answer it (`ServerDeps.okfCore`). */
export async function okfCodecOf(deps: Pick<ServerDeps, 'okfCore'>): Promise<OkfCodec> {
  return okfCodec(await deps.okfCore?.())
}
