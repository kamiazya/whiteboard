// @vitest-environment jsdom

import { DOCUMENT_NAME_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentNameField } from './DocumentNameField.js'

afterEach(cleanup)

describe('DocumentNameField', () => {
  it('shows the last path segment as the placeholder an empty name falls back to', () => {
    render(<DocumentNameField value="" path="design/login" onChange={() => {}} />)
    expect(screen.getByLabelText(/^Name/).getAttribute('placeholder')).toBe('login')
  })

  it('caps what can be typed at the length every keeper accepts', () => {
    render(<DocumentNameField value="" path="a" onChange={() => {}} />)
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).maxLength).toBe(
      DOCUMENT_NAME_MAX_LENGTH,
    )
  })

  it('reports what is typed and explains the fallback to the path', () => {
    const onChange = vi.fn()
    render(<DocumentNameField value="Login flow" path="a" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Sign-in' } })
    expect(onChange).toHaveBeenCalledWith('Sign-in')
    expect(screen.getByText(/Leave empty to show the last part of the path instead/)).toBeTruthy()
  })
})

const sources = Object.entries(
  import.meta.glob(['./*.tsx', '!./*.test.tsx', '!./*.browser.test.tsx'], {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>,
)

describe('the Name field of the document dialogs', () => {
  it('is written in one place, so create and rename cannot word it differently', () => {
    expect(sources.length).toBeGreaterThan(5)
    const holders = sources
      .filter(([, text]) => text.includes('What it is called'))
      .map(([file]) => file)
    expect(holders).toEqual(['./DocumentNameField.tsx'])
  })
})
