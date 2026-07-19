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

  test('WebMCP toggle defaults to ON and persists OFF to user-settings', () => {
    const onWebMcpChange = vi.fn()
    render(
      <SettingsPanel
        open={true}
        onOpenChange={() => {}}
        theme="system"
        onThemeChange={() => {}}
        onWebMcpChange={onWebMcpChange}
      />,
    )

    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(onWebMcpChange).toHaveBeenCalledWith(false)

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored.capabilities.webMcpEnabled).toBe(false)
  })

  test('WebMCP toggle reads persisted OFF state', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        storage: {},
        migration: {},
        capabilities: { webMcpEnabled: false },
      }),
    )

    render(
      <SettingsPanel open={true} onOpenChange={() => {}} theme="light" onThemeChange={() => {}} />,
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
      />,
    )

    expect(screen.queryByText('Settings')).toBeNull()
  })
})
