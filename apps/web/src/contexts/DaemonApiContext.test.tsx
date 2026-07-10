import { apiFetch } from '@kamiazya/whiteboard-mcp/api-client'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonApiContext, useDaemonApi, useHasDaemonApi } from './DaemonApiContext.js'

function Consumer() {
  const fetchFn = useDaemonApi()
  return <div data-testid="result">{fetchFn === apiFetch ? 'default' : 'injected'}</div>
}

function HasProviderConsumer() {
  const hasProvider = useHasDaemonApi()
  return <div data-testid="has-provider">{String(hasProvider)}</div>
}

afterEach(cleanup)

describe('DaemonApiContext', () => {
  it('returns the default apiFetch when no provider is mounted', () => {
    render(<Consumer />)
    expect(screen.getByTestId('result').textContent).toBe('default')
  })

  it('returns the injected fetch when a provider is mounted', () => {
    const injectedFetch: typeof fetch = async () => new Response(null)
    render(
      <DaemonApiContext.Provider value={injectedFetch}>
        <Consumer />
      </DaemonApiContext.Provider>,
    )
    expect(screen.getByTestId('result').textContent).toBe('injected')
  })
})

describe('useHasDaemonApi', () => {
  it('is false when no provider is mounted', () => {
    render(<HasProviderConsumer />)
    expect(screen.getByTestId('has-provider').textContent).toBe('false')
  })

  it('is true when a provider is mounted', () => {
    const injectedFetch: typeof fetch = async () => new Response(null)
    render(
      <DaemonApiContext.Provider value={injectedFetch}>
        <HasProviderConsumer />
      </DaemonApiContext.Provider>,
    )
    expect(screen.getByTestId('has-provider').textContent).toBe('true')
  })
})
