import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests, type LogRecord } from '../log.js'
import { parseWsClientTextMessage, parseWsTargetFromRequestUrl } from './ws-validation.js'

// Run `body` with a fresh log capture, always restoring the root level after.
function withCapturedLogs(body: (records: LogRecord[]) => void): void {
  const cap = captureLogsForTests('debug')
  try {
    body(cap.records)
  } finally {
    cap.restore()
  }
}

function expectAllWsWarnings(records: LogRecord[]): void {
  for (const record of records) {
    expect(record.level).toBe('warning')
    expect(record.scope).toBe('ws')
  }
}

describe('parseWsTargetFromRequestUrl', () => {
  it('takes a nested document path as plain slash segments', () => {
    expect(parseWsTargetFromRequestUrl('/ws/ws-1/notes/2026/plan', '127.0.0.1:3099')).toEqual({
      workspaceId: 'ws-1',
      path: 'notes/2026/plan',
    })
  })

  it('accepts validated workspaceId and encoded path', () => {
    expect(parseWsTargetFromRequestUrl('/ws/sess-1/nested%2Fpath', '127.0.0.1:3099')).toEqual({
      workspaceId: 'sess-1',
      path: 'nested/path',
    })
  })

  it('rejects invalid session ids before websocket upgrade', () => {
    expect(() => parseWsTargetFromRequestUrl('/ws/bad.sid/path', '127.0.0.1:3099')).toThrow(
      /Invalid workspaceId/,
    )
  })

  it('rejects invalid paths before websocket upgrade', () => {
    expect(() => parseWsTargetFromRequestUrl('/ws/sess-1/bad.path', '127.0.0.1:3099')).toThrow(
      /Invalid path/,
    )
  })

  it('rejects undefined rawUrl (raw TCP upgrade with no URL header)', () => {
    expect(() => parseWsTargetFromRequestUrl(undefined, '127.0.0.1:3099')).toThrow(
      /Invalid websocket path/,
    )
  })
})

describe('parseWsClientTextMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts a well-formed ws_trace message so the server can parent the next binary span', () => {
    const tp = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'
    expect(parseWsClientTextMessage(`{"type":"ws_trace","traceparent":"${tp}"}`)).toEqual({
      type: 'ws_trace',
      traceparent: tp,
    })
    expect(
      parseWsClientTextMessage(
        `{"type":"ws_trace","traceparent":"${tp}","tracestate":"vendor=abc"}`,
      ),
    ).toEqual({ type: 'ws_trace', traceparent: tp, tracestate: 'vendor=abc' })
  })

  it('rejects ws_trace messages whose traceparent is not W3C-shaped', () => {
    // Garbage strings must not poison the propagator. The guard lives in
    // the schema so a single regex check protects every consumer.
    expect(parseWsClientTextMessage('{"type":"ws_trace","traceparent":"junk"}')).toBeNull()
    expect(
      parseWsClientTextMessage(
        '{"type":"ws_trace","traceparent":"00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-bbbbbbbbbbbbbbbb-01"}',
      ),
    ).toBeNull() // uppercase hex
  })

  it('accepts the allowlisted client message types', () => {
    expect(parseWsClientTextMessage('{"type":"client_ready"}')).toEqual({
      type: 'client_ready',
    })
    expect(
      parseWsClientTextMessage(
        '{"type":"export_response","requestId":"req-1","data":"data:image/png;base64,abc"}',
      ),
    ).toEqual({
      type: 'export_response',
      requestId: 'req-1',
      data: 'data:image/png;base64,abc',
    })
    expect(parseWsClientTextMessage('{"type":"viewport_response","requestId":"req-2"}')).toEqual({
      type: 'viewport_response',
      requestId: 'req-2',
    })
  })

  it('returns null and warns for malformed or unknown messages', () => {
    withCapturedLogs((records) => {
      expect(parseWsClientTextMessage('{')).toBeNull()
      expect(parseWsClientTextMessage('[]')).toBeNull()
      expect(parseWsClientTextMessage('{"type":"unknown"}')).toBeNull()
      expect(parseWsClientTextMessage('{"type":"export_response","requestId":"req-1"}')).toBeNull()
      expect(parseWsClientTextMessage('{"type":"viewport_response"}')).toBeNull()

      expect(records).toHaveLength(5)
      expectAllWsWarnings(records)
    })
  })

  it('logs a distinct message for malformed JSON vs schema violations', () => {
    withCapturedLogs((records) => {
      // Non-parseable text → 'ignored invalid client message: malformed JSON'
      parseWsClientTextMessage('{not-json')
      // Valid JSON but wrong shape → 'ignored invalid client message'
      parseWsClientTextMessage('{"type":"export_response","requestId":"r"}')

      expect(records).toHaveLength(2)
      expect(records[0]!.msg).toBe('ignored invalid client message: malformed JSON')
      expect(records[1]!.msg).toBe('ignored invalid client message')
    })
  })

  it('rejects an object with no type field', () => {
    expect(parseWsClientTextMessage('{}')).toBeNull()
    expect(parseWsClientTextMessage('{"requestId":"r-1"}')).toBeNull()
  })

  it('rejects ws_trace with missing traceparent field', () => {
    expect(parseWsClientTextMessage('{"type":"ws_trace"}')).toBeNull()
    expect(parseWsClientTextMessage('{"type":"ws_trace","tracestate":"vendor=abc"}')).toBeNull()
  })

  it('rejects export_response with missing requestId', () => {
    expect(
      parseWsClientTextMessage('{"type":"export_response","data":"data:image/png;base64,abc"}'),
    ).toBeNull()
  })

  it('rejects export_response with both requestId and data missing', () => {
    expect(parseWsClientTextMessage('{"type":"export_response"}')).toBeNull()
  })

  it('rejects JSON primitives that are not objects (number, boolean, null)', () => {
    expect(parseWsClientTextMessage('42')).toBeNull()
    expect(parseWsClientTextMessage('true')).toBeNull()
    expect(parseWsClientTextMessage('"client_ready"')).toBeNull()
    expect(parseWsClientTextMessage('null')).toBeNull()
  })

  it('rejects empty string', () => {
    expect(parseWsClientTextMessage('')).toBeNull()
  })

  it('rejects messages where a required string field has the wrong type', () => {
    // requestId must be a string; a number should be rejected
    expect(
      parseWsClientTextMessage(
        '{"type":"export_response","requestId":123,"data":"data:image/png;base64,abc"}',
      ),
    ).toBeNull()
    expect(parseWsClientTextMessage('{"type":"viewport_response","requestId":null}')).toBeNull()
  })

  it('rejects ws_trace whose traceparent is the wrong type', () => {
    expect(parseWsClientTextMessage('{"type":"ws_trace","traceparent":42}')).toBeNull()
    expect(parseWsClientTextMessage('{"type":"ws_trace","traceparent":null}')).toBeNull()
  })

  it('rejects ws_trace where the version byte is not 00', () => {
    // The W3C spec reserves 00 as the only valid version; ff is explicitly
    // invalid per the trace-context spec section 2.2.
    expect(
      parseWsClientTextMessage(
        '{"type":"ws_trace","traceparent":"ff-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"}',
      ),
    ).toBeNull()
    expect(
      parseWsClientTextMessage(
        '{"type":"ws_trace","traceparent":"01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"}',
      ),
    ).toBeNull()
  })

  it('rejects export_response where data field has wrong type', () => {
    expect(
      parseWsClientTextMessage('{"type":"export_response","requestId":"req-1","data":123}'),
    ).toBeNull()
    expect(
      parseWsClientTextMessage('{"type":"export_response","requestId":"req-1","data":null}'),
    ).toBeNull()
  })

  it('logs a warning for every rejected primitive and wrong-type payload', () => {
    withCapturedLogs((records) => {
      parseWsClientTextMessage('42')
      parseWsClientTextMessage('true')
      parseWsClientTextMessage('null')
      parseWsClientTextMessage('')
      parseWsClientTextMessage(
        '{"type":"export_response","requestId":123,"data":"data:image/png;base64,x"}',
      )

      expect(records).toHaveLength(5)
      expectAllWsWarnings(records)
    })
  })
})
