import { type SpatialCodec, spatialCodec } from '@kamiazya/whiteboard-codec'
import type { ServerDeps } from '../server-deps.js'

/** The JSON Canvas codec as this server's deps say to answer it (`ServerDeps.spatialCore`). */
export async function spatialCodecOf(deps: Pick<ServerDeps, 'spatialCore'>): Promise<SpatialCodec> {
  return spatialCodec(await deps.spatialCore?.())
}
