/**
 * Dynamic favicon: the boot-splash mark (board + squiggle) as a live status
 * surface. Two user-selectable styles (see SettingsPanel):
 *
 * - 'minimap': the board is filled with an abstract minimap of the actual
 *   canvas (nodes as small filled rects); an empty canvas falls back to the
 *   logo squiggle.
 * - 'dot': always the logo squiggle.
 *
 * Both carry the same status grammar: green dot = saved, amber = unsaved,
 * blue = syncing, and offline breaks the board outline into dashes (the
 * frame IS the connection) besides a gray dot and a faded mark.
 *
 * Redraws happen only on state changes — no animation frames — so
 * background-tab timer throttling never distorts it. Browsers without
 * canvas 2D (and Safari, which ignores dynamic favicons) keep the static
 * /favicon.svg.
 */

export type FaviconStatus = 'saved' | 'unsaved' | 'syncing' | 'offline'
export type FaviconStyle = 'minimap' | 'dot'

import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'

export interface FaviconRect {
  x: number
  y: number
  w: number
  h: number
  /** Fill for the minimap rect; resolveRectColor() supplies it. */
  color?: string
}

/**
 * Resolve a node's JSON Canvas color (preset key '1'-'6' or '#rrggbb') to a
 * minimap fill. Presets use the light palette's STROKE values — at 32px the
 * tint fills would wash out; the strong accents are what read. Colorless
 * nodes stay the neutral gray.
 */
export function resolveRectColor(color: string | undefined): string {
  if (color === undefined) return GRAY
  if (color.startsWith('#')) return color
  const preset = SPATIAL_LIGHT_PALETTE.presets[color as keyof typeof SPATIAL_LIGHT_PALETTE.presets]
  return preset?.stroke ?? GRAY
}

export const STATIC_FAVICON_HREF = '/favicon.svg'

// 32x32 icon space. INNER is the drawable area inside the board frame.
const BOARD = { x: 1.6, y: 4.4, w: 28.8, h: 23.2, r: 5 }
const INNER = { x: 4.4, y: 7.2, w: 23.2, h: 17.6 }
const MIN_RECT_PX = 1.4
const MAX_RECTS = 16

const GREEN = '#16a34a'
const AMBER = '#d97706'
const BLUE = '#3b6ecc'
const GRAY = '#909090'
const OFFLINE_GRAY = '#7c7c7c'
const BOARD_LINE = 'rgba(156, 163, 175, 0.62)'

const DOT_COLOR: Record<FaviconStatus, string> = {
  saved: GREEN,
  unsaved: AMBER,
  syncing: BLUE,
  offline: OFFLINE_GRAY,
}

/**
 * Project scene node bounding boxes into the icon's board area: uniform
 * scale (shapes keep their proportions), centered, each rect clamped to a
 * visible minimum. Huge scenes are capped to the largest rects — at 32px
 * anything beyond that is noise.
 */
export function projectRectsToBoard(rects: readonly FaviconRect[]): FaviconRect[] {
  if (rects.length === 0) return []
  const kept = [...rects].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, MAX_RECTS)
  const minX = Math.min(...kept.map((r) => r.x))
  const minY = Math.min(...kept.map((r) => r.y))
  const maxX = Math.max(...kept.map((r) => r.x + r.w))
  const maxY = Math.max(...kept.map((r) => r.y + r.h))
  const bw = Math.max(1, maxX - minX)
  const bh = Math.max(1, maxY - minY)
  const scale = Math.min(INNER.w / bw, INNER.h / bh)
  const offsetX = INNER.x + (INNER.w - bw * scale) / 2
  const offsetY = INNER.y + (INNER.h - bh * scale) / 2
  return kept.map((r) => ({
    x: offsetX + (r.x - minX) * scale,
    y: offsetY + (r.y - minY) * scale,
    w: Math.max(MIN_RECT_PX, r.w * scale),
    h: Math.max(MIN_RECT_PX, r.h * scale),
    color: r.color,
  }))
}

function drawBoard(ctx: CanvasRenderingContext2D, status: FaviconStatus): void {
  ctx.save()
  ctx.strokeStyle = BOARD_LINE
  ctx.lineWidth = 2.4
  // Offline: the outline itself breaks into dashes — legible even at 16px.
  if (status === 'offline') ctx.setLineDash([3.4, 2.6])
  const { x, y, w, h, r } = BOARD
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
  ctx.stroke()
  ctx.restore()
}

function drawSquiggle(ctx: CanvasRenderingContext2D): void {
  // The boot-splash path (M20 44 C 27 22, 37 22, 44 33 S 58 50, 68 25 in
  // 88x66 space), scaled into the 32px icon.
  const s = 0.3273
  const dy = 3.2
  ctx.save()
  ctx.strokeStyle = GRAY
  ctx.lineWidth = 2.6
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(20 * s + 1.6, 44 * s + dy)
  ctx.bezierCurveTo(27 * s + 1.6, 22 * s + dy, 37 * s + 1.6, 22 * s + dy, 44 * s + 1.6, 33 * s + dy)
  ctx.bezierCurveTo(51 * s + 1.6, 44 * s + dy, 58 * s + 1.6, 50 * s + dy, 68 * s + 1.6, 25 * s + dy)
  ctx.stroke()
  ctx.restore()
}

function drawStatusDot(ctx: CanvasRenderingContext2D, status: FaviconStatus): void {
  const x = 26.5
  const y = 6.5
  ctx.save()
  // Punch a transparent ring first so the dot separates from the board line
  // and from any tab-strip color behind the icon.
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(x, y, 6.4, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  ctx.beginPath()
  ctx.arc(x, y, 4.6, 0, Math.PI * 2)
  ctx.fillStyle = DOT_COLOR[status]
  ctx.fill()
  ctx.restore()
}

/**
 * Render the favicon as a PNG data URL, or null where canvas 2D is
 * unavailable (jsdom, ancient browsers) — callers keep the static icon.
 */
export function renderFavicon({
  style,
  status,
  rects,
}: {
  style: FaviconStyle
  status: FaviconStatus
  rects: readonly FaviconRect[]
}): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  ctx.clearRect(0, 0, 32, 32)
  ctx.globalAlpha = status === 'offline' ? 0.45 : 1
  drawBoard(ctx, status)
  const projected = style === 'minimap' ? projectRectsToBoard(rects) : []
  if (projected.length === 0) {
    drawSquiggle(ctx)
  } else {
    ctx.save()
    for (const r of projected) {
      ctx.fillStyle = r.color ?? GRAY
      ctx.fillRect(r.x, r.y, r.w, r.h)
    }
    ctx.restore()
  }
  ctx.globalAlpha = 1
  drawStatusDot(ctx, status)
  return canvas.toDataURL('image/png')
}

/**
 * Install/update the favicon link. Passing null restores the static icon
 * (the unmount path). Removes any competing icon links once so the dynamic
 * icon and the static fallback never fight.
 */
export function applyFavicon(href: string | null, doc: Document = document): void {
  let link = doc.head.querySelector<HTMLLinkElement>('link[rel="icon"][data-wb-favicon]')
  if (link === null) {
    for (const stale of doc.head.querySelectorAll('link[rel="icon"]')) stale.remove()
    link = doc.createElement('link')
    link.rel = 'icon'
    link.dataset.wbFavicon = ''
    doc.head.append(link)
  }
  link.href = href ?? STATIC_FAVICON_HREF
}
