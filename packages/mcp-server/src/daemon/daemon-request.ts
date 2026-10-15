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
}

export interface DaemonAnswer {
  readonly status: number
  /** The JSON body, or the raw text when it is not JSON. */
  readonly body: unknown
}

export function requestDaemon(req: DaemonRequest): Promise<DaemonAnswer> {
  return new Promise((resolve, reject) => {
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body)
    const outgoing = httpRequest(
      {
        socketPath: req.record.socketPath,
        method: req.method,
        path: req.path,
        headers: {
          ...(req.record.token === undefined
            ? {}
            : { authorization: `Bearer ${req.record.token}` }),
          accept: 'application/json',
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = text
          try {
            body = text === '' ? undefined : JSON.parse(text)
          } catch {
            // Not JSON: reported as the text it was.
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    outgoing.on('error', reject)
    if (req.timeoutMs !== undefined) {
      const ms = req.timeoutMs
      outgoing.setTimeout(ms, () => outgoing.destroy(new Error(`no answer within ${ms}ms`)))
    }
    if (payload !== undefined) outgoing.write(payload)
    outgoing.end()
  })
}
