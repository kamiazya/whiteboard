const IMAGE_HREF = /(<image\b[^>]*?)\s(?:xlink:)?href="([^"]*)"/g

/**
 * The SVG with every `<image href>` that is not a `data:` URI dropped.
 *
 * resvg resolves any other href by reading it from THIS host's filesystem —
 * an absolute path as written, a relative one against the working directory —
 * and does so synchronously. The href comes from a document whoever can edit
 * it wrote, so leaving it would draw a daemon-host file into the export, or,
 * naming a device such as `/dev/zero`, read without bound on the serving
 * loop. resvg never fetches a remote URL either, so dropping those costs the
 * picture nothing it would have drawn. An `<image>` with no href draws
 * nothing, which is what an unloadable picture already looked like.
 */
export function withoutExternalImages(svg: string): string {
  return svg.replace(IMAGE_HREF, (whole, head: string, href: string) =>
    href.startsWith('data:') ? whole : head,
  )
}
