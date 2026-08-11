import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { STORAGE_KEY } from '@/lib/user-settings-store'
import { SettingsPanel } from './SettingsPanel'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('SettingsPanel', () => {
  test('renders theme options and allows switching', () => {
    const onThemeChange = vi.fn()
    render(
      <SettingsPanel
        open={true}
        onOpenChange={() => {}}
        theme="system"
        onThemeChange={onThemeChange}
        webMcpEnabled={true}
      />,
    )

    const lightBtn = screen.getByRole('radio', { name: /light/i })
    const darkBtn = screen.getByRole('radio', { name: /dark/i })
    const systemBtn = screen.getByRole('radio', { name: /system/i })

    expect(systemBtn.getAttribute('aria-checked')).toBe('true')
    expect(lightBtn.getAttribute('aria-checked')).toBe('false')
    expect(darkBtn.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(darkBtn)
    expect(onThemeChange).toHaveBeenCalledWith('dark')
  })

  test('WebMCP toggle persists OFF to user-settings and notifies parent', () => {
    const onWebMcpChange = vi.fn()
    const { rerender } = render(
      <SettingsPanel
        open={true}
        onOpenChange={() => {}}
        theme="system"
        onThemeChange={() => {}}
        webMcpEnabled={true}
        onWebMcpChange={onWebMcpChange}
      />,
    )

    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    expect(onWebMcpChange).toHaveBeenCalledWith(false)

    rerender(
      <SettingsPanel
        open={true}
        onOpenChange={() => {}}
        theme="system"
        onThemeChange={() => {}}
        webMcpEnabled={false}
        onWebMcpChange={onWebMcpChange}
      />,
    )
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored.capabilities.webMcpEnabled).toBe(false)
  })

  test('WebMCP toggle reflects controlled OFF state', () => {
    render(
      <SettingsPanel
        open={true}
        onOpenChange={() => {}}
        theme="light"
        onThemeChange={() => {}}
        webMcpEnabled={false}
      />,
    )

    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  test('does not render content when closed', () => {
    render(
      <SettingsPanel
        open={false}
        onOpenChange={() => {}}
        theme="system"
        onThemeChange={() => {}}
        webMcpEnabled={true}
      />,
    )

    expect(screen.queryByText('Settings')).toBeNull()
  })
})

describe('SettingsPanel — favicon style', () => {
  test('renders both style options with minimap as the default selection', () => {
    render(
      <SettingsPanel
        open={true}
        onOpenChange={() => {}}
        theme="system"
        onThemeChange={() => {}}
        webMcpEnabled={false}
      />,
    )
    const minimap = screen.getByRole('radio', { name: /minimap/i })
    const dot = screen.getByRole('radio', { name: /dot/i })
    expect(minimap.getAttribute('aria-checked')).toBe('true')
    expect(dot.getAttribute('aria-checked')).toBe('false')
  })

  test('selecting Dot persists to user-settings and notifies the parent', () => {
    const onFaviconStyleChange = vi.fn()
    render(
      <SettingsPanel
        open={true}
        onOpenChange={() => {}}
        theme="system"
        onThemeChange={() => {}}
        webMcpEnabled={false}
        onFaviconStyleChange={onFaviconStyleChange}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: /dot/i }))
    expect(onFaviconStyleChange).toHaveBeenCalledWith('dot')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.appearance?.faviconStyle).toBe('dot')
  })

  test('reflects a persisted dot preference on open', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        storage: {},
        migration: {},
        capabilities: {},
        appearance: { faviconStyle: 'dot' },
      }),
    )
    render(
      <SettingsPanel
        open={true}
        onOpenChange={() => {}}
        theme="system"
        onThemeChange={() => {}}
        webMcpEnabled={false}
      />,
    )
    expect(screen.getByRole('radio', { name: /dot/i }).getAttribute('aria-checked')).toBe('true')
  })
})
