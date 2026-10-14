/**
 * The offline replica's picture seams for copy and paste.
 *
 * The replica is a cache of a daemon workspace, so its pictures live where
 * that workspace's do: the scope is the daemon adapter's own, and a copy made
 * here pastes on the daemon page of the same workspace with its references
 * kept, as one made there pastes here. Bytes come from the sealed image
 * cache, the only copy the page holds while the daemon is away.
 *
 * Storing needs the daemon, so a picture from anywhere else is refused with
 * that reason and left out of the paste. Landing its reference instead would
 * draw nothing here and ship to the daemon a name it holds no bytes for.
 */
import { imageRefId } from '@kamiazya/whiteboard-model'
import type { ClipboardImageSeams } from './clipboard-images.js'
import { createDaemonFileAdapter } from './daemon-file-adapter.js'
import { loadReplicaImages } from './replica-images.js'

/** Why a picture from another workspace or keeper cannot be pasted while the daemon is away. */
const REPLICA_STORE_REFUSAL =
  'pictures from another workspace are stored by the daemon, which is unreachable. Paste them again once it is back.'

const neverFetched: typeof fetch = () =>
  Promise.reject(new Error('the replica reads its pictures from its own cache'))

export function replicaClipboardImages(
  daemonBaseUrl: string,
  workspaceId: string,
): ClipboardImageSeams {
  // Read off the adapter rather than respelled, so the two scopes cannot drift apart.
  const { fileScope } = createDaemonFileAdapter({
    daemonFetch: neverFetched,
    daemonBaseUrl,
    workspaceId,
    path: '',
  })
  return {
    fileScope,
    readImage: async (ref) => {
      // A failed read rejects, as every keeper's seam does; the copy leaves
      // that picture out either way, but only an absent one is "none".
      const id = imageRefId(ref)
      const { images, failed } = await loadReplicaImages(workspaceId, [id])
      if (failed.has(id)) throw new Error(`picture ${id} could not be read from the replica cache`)
      return images.get(id)
    },
    storeImage: async () => ({ ok: false, reason: REPLICA_STORE_REFUSAL }),
  }
}
