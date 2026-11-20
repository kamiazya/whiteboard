import { frontiersToBase64 } from '@kamiazya/whiteboard-history'
import { encodeFrontiers, type Frontiers } from 'loro-crdt'

// The frontiers an adopted row carries arrive as a `Frontiers` from the seam,
// and are stored as the engine's bytes in base64.
//
// ponytail: in one file so the version store itself imports no loro-crdt; it
// goes when promote-carried hands the frontiers as bytes.

/** A frontier as the text a version row stores: the engine's bytes, base64. */
export function frontiersToText(frontiers: Frontiers): string {
  return frontiersToBase64(encodeFrontiers(frontiers))
}
