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
 *
 * Those two wants differ, and the difference is why this is not the
 * daemon's `did:key`. On the LIVE SOCKET a per-process id is the right
 * answer — the question is which session is editing right now, and it is
 * asked and answered inside one process lifetime. In a STORED version row
 * it is a placeholder: a row saved before a restart and one saved after
 * name different agents, though both are this daemon. The row's real
 * answer is the device DID (ADR-0035 decision 2), which the HTTP save
 * route already stamps because `app.ts` has the identity there; the
 * container that wires the agent's own save does not, and threading it is
 * the follow-up.
 *
 * Written in OKF §7's `process:<id>` form so the one vocabulary holds even
 * while the value is a placeholder.
 */
export const DAEMON_AGENT_ACTOR = `process:daemon-${nanoid(10)}`
