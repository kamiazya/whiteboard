import { describe, expect, it } from 'vitest'
import { authorizeWsUpgrade } from './routes/ws-auth.js'

describe('authorizeWsUpgrade', () => {
  it('rejects websocket upgrade without the daemon subprotocol token when token auth is enabled', () => {
    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
        },
        'secret',
      ),
    ).toEqual({ accept: false, statusCode: 401 })
  })

  it('rejects websocket upgrade when the daemon subprotocol token is wrong', () => {
    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          'sec-websocket-protocol': 'excalidraw-v1, daemon-token.nope',
        },
        'secret',
      ),
    ).toEqual({ accept: false, statusCode: 401 })
  })

  it('accepts websocket upgrade with the daemon subprotocol token and selects excalidraw-v1', () => {
    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'http://127.0.0.1:5173',
          'sec-websocket-protocol': 'excalidraw-v1, daemon-token.secret',
        },
        'secret',
      ),
    ).toEqual({ accept: true, protocol: 'excalidraw-v1' })
  })

  it('keeps websocket auth disabled when daemon token is unset', () => {
    expect(
      authorizeWsUpgrade({
        host: '127.0.0.1:3099',
      }),
    ).toEqual({ accept: true, protocol: undefined })
  })

  it('rejects browser origins that are not same-host localhost addresses', () => {
    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'http://localhost:5173',
          'sec-websocket-protocol': 'excalidraw-v1, daemon-token.secret',
        },
        'secret',
      ),
    ).toEqual({ accept: false, statusCode: 403 })

    expect(
      authorizeWsUpgrade(
        {
          host: '127.0.0.1:3099',
          origin: 'https://example.com',
          'sec-websocket-protocol': 'excalidraw-v1, daemon-token.secret',
        },
        'secret',
      ),
    ).toEqual({ accept: false, statusCode: 403 })
  })
})
