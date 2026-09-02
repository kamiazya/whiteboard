import { nanoid } from 'nanoid'

/**
 * The daemon's identity as an editing peer, minted once per process.
 *
 * server-core deliberately does not supply this — it has no idea who the
 * daemon's peer is, and inventing one there would put a second source of
 * truth beside `operatorInfoSchema`. Stable for the daemon's lifetime so a
 * browser can tell "the same agent again" from "a second agent". One
 * module, because two things stamp it: the activity a tool announces over
 * the socket, and the operator a tool-saved version records.
 */
export const DAEMON_PEER_ID = `daemon-${nanoid(10)}`
