// The one tag control (ADR-0040 decision 6): a note's header, a box, an edge
// and the board are all tagged through this, so what a chip looks like and
// what Enter does is decided once.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TagChipsEditor } from './TagChipsEditor.js'

afterEach(cleanup)

const box = () => screen.getByLabelText(/add tag/i) as HTMLInputElement
const commit = (value: string) => {
  fireEvent.change(box(), { target: { value } })
  fireEvent.keyDown(box(), { key: 'Enter' })
}

describe('TagChipsEditor', () => {
  it('shows each tag as a chip with its own remove control', () => {
    const onChange = vi.fn()
    render(<TagChipsEditor tags={['health:ok', 'draft']} onChange={onChange} />)
    expect(screen.getByText('health:ok')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /remove tag draft/i }))
    expect(onChange).toHaveBeenCalledWith(['health:ok'])
  })

  it('Enter and a comma both finish a tag; the box empties for the next', () => {
    const onChange = vi.fn()
    render(<TagChipsEditor tags={[]} onChange={onChange} />)
    commit('ops')
    expect(onChange).toHaveBeenLastCalledWith(['ops'])
    expect(box().value).toBe('')
    fireEvent.change(box(), { target: { value: 'team:core' } })
    fireEvent.keyDown(box(), { key: ',' })
    expect(onChange).toHaveBeenLastCalledWith(['team:core'])
  })

  it('a blank or duplicate tag is not written', () => {
    const onChange = vi.fn()
    render(<TagChipsEditor tags={['ops']} onChange={onChange} />)
    commit('ops')
    commit('   ')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not finish a tag on the Enter that confirms an IME composition', () => {
    const onChange = vi.fn()
    render(<TagChipsEditor tags={[]} onChange={onChange} />)
    fireEvent.change(box(), { target: { value: '企画' } })
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses a colon-bearing tag that is not key:value, says the rule, and keeps the draft', () => {
    const onChange = vi.fn()
    render(<TagChipsEditor tags={[]} onChange={onChange} />)
    commit('Health:OK')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('key:value')
    expect(box().value).toBe('Health:OK')
    // Correcting it clears the refusal and writes.
    commit('health:ok')
    expect(onChange).toHaveBeenLastCalledWith(['health:ok'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers keys and plain tags before a colon, and the values under the key being typed after one', () => {
    render(
      <TagChipsEditor
        tags={[]}
        onChange={() => {}}
        suggestions={['health:ok', 'health:failing', 'tier:web', 'draft']}
      />,
    )
    const options = () =>
      [...document.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))
    expect(options()).toEqual(['draft', 'health:', 'tier:'])
    fireEvent.change(box(), { target: { value: 'health:' } })
    expect(options()).toEqual(['health:failing', 'health:ok'])
  })

  it('refuses what the workspace library forbids, with the rule, and keeps the draft', () => {
    const onChange = vi.fn()
    const library = {
      health: { exclusive: true, values: { ok: { color: '4' as const }, failing: {} } },
    }
    render(<TagChipsEditor tags={['health:ok']} onChange={onChange} library={library} />)
    commit('health:degraded')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/health.*failing, ok/)
    expect(box().value).toBe('health:degraded')
    commit('health:failing')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/one value at a time/)
    commit('region:eu')
    expect(onChange).toHaveBeenLastCalledWith(['health:ok', 'region:eu'])
  })

  it('offers the values the library declares under the key being typed, beside what is in use', () => {
    const library = { health: { values: { ok: {}, failing: {} } } }
    render(
      <TagChipsEditor
        tags={[]}
        onChange={vi.fn()}
        library={library}
        suggestions={['health:degraded']}
      />,
    )
    fireEvent.change(box(), { target: { value: 'health:' } })
    const offered = [...document.querySelectorAll('datalist option')].map((o) =>
      o.getAttribute('value'),
    )
    expect(offered).toEqual(['health:degraded', 'health:failing', 'health:ok'])
  })
})
