import { afterEach, describe, expect, it } from 'vitest'
import { savedPicture } from './document-export.js'

const minted: string[] = []

afterEach(() => {
  for (const url of minted.splice(0)) URL.revokeObjectURL(url)
})

/** A page-local picture, the way the editor holds a stored one. */
async function pageLocalPng(): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 3
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('no 2D context')
  context.fillStyle = '#ff0000'
  context.fillRect(0, 0, 4, 3)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('toBlob produced nothing')
  const url = URL.createObjectURL(blob)
  minted.push(url)
  return url
}

const drawnWith = (href: string) => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><image x="0" y="0" width="4" height="3" href="${href}"/></svg>`,
  bounds: { x: 0, y: 0, w: 4, h: 3 },
})

describe('savedPicture', () => {
  it('writes a page-local picture into the file as its pixels', async () => {
    const saved = await savedPicture('svg', drawnWith(await pageLocalPng()))
    const svg = (await saved?.text()) ?? ''
    expect(svg).toMatch(/href="data:image\/png;base64,[A-Za-z0-9+/=]+"/)
    expect(svg).not.toContain('blob:')
  })

  it('leaves out a picture over the bound rather than a dangling reference', async () => {
    const saved = await savedPicture('svg', drawnWith(await pageLocalPng()), { maxImageBytes: 8 })
    expect(await saved?.text()).toContain('href=""')
  })
})
