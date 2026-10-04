import { cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { SceneSvg } from './SceneSvg.js'

afterEach(cleanup)

const SVG = '<svg viewBox="0 0 10 10" width="10" height="10"><rect width="4" height="4"/></svg>'

describe('SceneSvg', () => {
  it('parses the serializer string into real SVG elements, not text', () => {
    const { getByTestId } = render(<SceneSvg svg={SVG} data-testid="host" />)
    const host = getByTestId('host')
    expect(host.querySelector('svg > rect')).not.toBeNull()
    expect(host.textContent).toBe('')
  })

  it('draws into a div unless told which element the host is', () => {
    const { getByTestId } = render(
      <>
        <SceneSvg svg={SVG} data-testid="default" />
        <SceneSvg svg={SVG} as="figure" data-testid="fig" />
        <SceneSvg svg={SVG} as="span" data-testid="inline" />
      </>,
    )
    expect(getByTestId('default').tagName).toBe('DIV')
    expect(getByTestId('fig').tagName).toBe('FIGURE')
    expect(getByTestId('inline').tagName).toBe('SPAN')
  })

  it('forwards the host element attributes and its ref', () => {
    const ref = createRef<HTMLElement>()
    const { getByTestId } = render(
      <SceneSvg
        ref={ref}
        svg={SVG}
        data-testid="host"
        className="size-full"
        aria-hidden="true"
        style={{ pointerEvents: 'none' }}
      />,
    )
    const host = getByTestId('host')
    expect(ref.current).toBe(host)
    expect(host.className).toBe('size-full')
    expect(host.getAttribute('aria-hidden')).toBe('true')
    expect(host.style.pointerEvents).toBe('none')
  })

  it('replaces the drawing when the string changes', () => {
    const { getByTestId, rerender } = render(<SceneSvg svg={SVG} data-testid="host" />)
    rerender(<SceneSvg svg={'<svg viewBox="0 0 1 1"><circle r="1"/></svg>'} data-testid="host" />)
    const host = getByTestId('host')
    expect(host.querySelector('circle')).not.toBeNull()
    expect(host.querySelector('rect')).toBeNull()
  })

  it('does not interpret an escaped text run as markup', () => {
    const escaped = '<svg viewBox="0 0 1 1"><text>&lt;img src=x onerror=alert(1)&gt;</text></svg>'
    const { getByTestId } = render(<SceneSvg svg={escaped} data-testid="host" />)
    const host = getByTestId('host')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('text')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })
})
