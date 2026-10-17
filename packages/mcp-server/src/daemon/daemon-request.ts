// One HTTP exchange with the daemon a daemon.json names, over the owner-only
// socket (a named pipe on Windows) the record gives — the only place a local
// daemon answers (ADR-0050). The record's token goes as the Bearer credential
// when it has one, exactly as the native host attaches it.

import { request as httpRequest } from 'node:http'
import type { DaemonRecord } from './daemon-record-schema.js'

export interface DaemonRequest {
  readonly record: Pick<DaemonRecord, 'socketPath'> & { readonly token?: string }
  readonly method: 'GET' | 'POST' | 'PUT'
  readonly path: string
  readonly body?: unknown
  /** Abandons the exchange when no answer lands within this; none waits as long as it takes. */
  readonly timeoutMs?: number
  /**
   * Abandons the exchange this long after it starts, however steadily bytes
   * arrive — `timeoutMs` restarts on each one, so a server trickling its
   * answer outlasts it indefinitely.
   */
  readonly deadlineMs?: number
  /** Abandons the exchange once the body passes this many bytes, rather than holding all of it. */
  readonly maxBodyBytes?: number
}

export interface DaemonAnswer {
  readonly status: number
  /** The JSON body, or the raw text when it is not JSON. */
  readonly body: unknown
}

/**
 * The socket accepted the connection and then gave no complete answer — in
 * time, or at all. Unlike a refused connection, this says something is
 * serving there: a daemon too busy to answer is still a daemon.
 */
export class DaemonNoAnswerError extends Error {
  override readonly name = 'DaemonNoAnswerError'
}

function headersFor(req: DaemonRequest, payload: string | undefined) {
  return {
    ...(req.record.token === undefined ? {} : { authorization: `Bearer ${req.record.token}` }),
    accept: 'application/json',
    ...(payload === undefined
      ? {}
      : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
  }
}

/** The JSON body, or the raw text when it is not JSON. */
function bodyOf(text: string): unknown {
  try {
    return text === '' ? undefined : JSON.parse(text)
  } catch {
    return text
  }
}

export function requestDaemon(req: DaemonRequest): Promise<DaemonAnswer> {
  return new Promise((resolve, reject) => {
    let connected = false
    const fail = (err: Error) => {
      clearTimeout(deadline)
      reject(connected ? new DaemonNoAnswerError(err.message, { cause: err }) : err)
    }
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body)
    const outgoing = httpRequest(
      {
        socketPath: req.record.socketPath,
        method: req.method,
        path: req.path,
        headers: headersFor(req, payload),
      },
      (res) => {
        const chunks: Buffer[] = []
        let received = 0
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (req.maxBodyBytes !== undefined && received > req.maxBodyBytes) {
            outgoing.destroy(new Error(`answer exceeds ${req.maxBodyBytes} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', fail)
        res.on('end', () => {
          clearTimeout(deadline)
          const body = bodyOf(Buffer.concat(chunks).toString('utf8'))
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    const deadline =
      req.deadlineMs === undefined
        ? undefined
        : setTimeout(
            () => outgoing.destroy(new Error(`no complete answer within ${req.deadlineMs}ms`)),
            req.deadlineMs,
          )
    outgoing.on('socket', (socket) => {
      // A kept-alive socket is handed over already connected.
      if (!socket.connecting) connected = true
      else
        socket.once('connect', () => {
          connected = true
        })
    })
    outgoing.on('error', fail)
    if (req.timeoutMs !== undefined) {
      const ms = req.timeoutMs
      outgoing.setTimeout(ms, () => outgoing.destroy(new Error(`no answer within ${ms}ms`)))
    }
    if (payload !== undefined) outgoing.write(payload)
    outgoing.end()
  })
}
