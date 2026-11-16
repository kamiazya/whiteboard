// The widget shows a picture the daemon laid out (q54), so what has to hold in
// a real browser is the half that is still the widget's: the picture is placed
// only when it cannot run anything, it scales into the widget's fixed frame,
// and a click on it still names the node drawn there — letterboxed or not.

import {
  type CanvasViewPicture,
  constantRatioMeasureText,
  createSpatialTheme,
  hitBoxesOf,
  layoutSpatialCanvas,
  renderSceneToSvg,
} from '@kamiazya/whiteboard-canvas-render'
import { pictureNodeAt } from '@kamiazya/whiteboard-canvas-render/canvas-view-picture'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { canvasPointFromClick } from './canvas-point.js'
import { mountPicture, pictureDeclaresFamily, pictureSvgElement } from './picture-view.js'

// A wide board in a frame shaped like the widget's (600x480): the picture
// keeps its proportions, so it is letterboxed above and below.
const canvas = {
  nodes: [
    groupNode({ id: 'frame', x: 0, y: 0, width: 1200, height: 240, label: 'Lane' }),
    textNode({ id: 'left', x: 40, y: 10, width: 200, height: 30, text: 'left' }),
    textNode({ id: 'right', x: 900, y: 10, width: 200, height: 30, text: 'right' }),
  ],
  edges: [],
}

/** The picture `canvas_view` hands over, drawn the way the daemon draws it. */
function daemonPicture(): CanvasViewPicture {
  const scene = layoutSpatialCanvas(canvas, {
    measure: constantRatioMeasureText,
    appearance: createSpatialTheme({ mode: 'light' }),
  })
  return {
    svg: renderSceneToSvg(scene, { padding: 0, background: '#ffffff' }),
    boxes: hitBoxesOf(canvas.nodes),
  }
}

function frame(): HTMLElement {
  const container = document.createElement('div')
  container.style.width = '600px'
  container.style.height = '480px'
  document.body.append(container)
  return container
}

/** The screen point at the centre of the chrome rect drawn at a node's box. */
function centreOf(svg: SVGSVGElement, box: { x: number; width: number; y: number }) {
  const rect = [...svg.querySelectorAll('rect')].find(
    (node) => node.getAttribute('x') === String(box.x) && node.getAttribute('y') === String(box.y),
  )
  if (rect === undefined) throw new Error(`no rect drawn at ${box.x},${box.y}`)
  const r = rect.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

describe('the picture the widget shows', () => {
  // biome-ignore lint/plugin: the picture is plain DOM, no React root
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('names the node drawn under a click on a letterboxed picture', () => {
    const picture = daemonPicture()
    const element = pictureSvgElement(picture.svg)
    if (element === undefined) throw new Error('the daemon picture was refused')
    mountPicture(frame(), element)

    // The element fills the 480px frame; the wide drawing inside it does not.
    expect(element.getBoundingClientRect().height).toBe(480)
    for (const [id, box] of [
      ['left', canvas.nodes[1]!],
      ['right', canvas.nodes[2]!],
    ] as const) {
      const at = centreOf(element, box)
      const point = canvasPointFromClick(element, at.x, at.y)
      expect(point === undefined ? undefined : pictureNodeAt(picture, point)).toBe(id)
    }
    // Inside the frame but on no member: the frame.
    const corner = centreOf(element, canvas.nodes[0]!)
    const point = canvasPointFromClick(element, corner.x, corner.y)
    expect(point === undefined ? undefined : pictureNodeAt(picture, point)).toBe('frame')
  })

  it('places a figure named by the host, holding the text the board says', () => {
    const element = pictureSvgElement(daemonPicture().svg)
    if (element === undefined) throw new Error('the daemon picture was refused')
    const container = frame()
    const handle = mountPicture(container, element, 'Roadmap')

    const figure = container.querySelector('figure')
    expect(figure?.getAttribute('aria-label')).toBe('Roadmap')
    expect(figure?.textContent).toContain('right')
    handle.dispose()
    expect(container.querySelector('figure')).toBeNull()
  })

  it.each([
    ['a script element', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'],
    ['an event handler', '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="1"/></svg>'],
    ['a handler on the root', '<svg xmlns="http://www.w3.org/2000/svg" onload="1"/>'],
    [
      'a script URL',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href=" javascript:1"><text>x</text></a></svg>',
    ],
    [
      'a script URL split by a newline reference',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#xA;script:1"><text>x</text></a></svg>',
    ],
    [
      'a script URL split by a tab reference',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#x9;javascript:1"><text>x</text></a></svg>',
    ],
    [
      'an animation that writes a link',
      '<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="javascript:1"/><text>x</text></a></svg>',
    ],
    [
      'an animation of an attribute',
      '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" values="javascript:1"/></a></svg>',
    ],
    [
      'foreign markup',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    ],
    ['markup that is not SVG', '<div xmlns="http://www.w3.org/1999/xhtml"/>'],
    ['markup that does not parse', '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'],
  ])('refuses %s', (_what, svg) => {
    expect(pictureSvgElement(svg)).toBeUndefined()
  })

  it('reads which family the picture declares, so a face it names is the one fetched', () => {
    const element = pictureSvgElement(
      '<svg xmlns="http://www.w3.org/2000/svg"><text font-family="\'Yomogi\', Roboto">a</text></svg>',
    )
    if (element === undefined) throw new Error('refused')
    expect(pictureDeclaresFamily(element, 'Yomogi')).toBe(true)
    expect(pictureDeclaresFamily(element, 'Yomo')).toBe(false)
  })
})
