/**
 * The most nodes, and the most edges, one canvas may hold.
 *
 * A COST bound, sized against what every read of the board repeats: a
 * render, an export, a layout read and a tidy each lay the whole canvas out
 * again, on the loop that answers every other request. Edge routing is what
 * grows — each edge is weighed against the boxes around it — so the bound
 * that matters is the edge one, and the node one keeps the boxes each edge is
 * weighed against in the same range. Measured with
 * `mcp-server/scripts/measure/canvas-size-cost.mjs` (CPU ms for one layout
 * through the daemon's measurer, clustered boards at about one edge per
 * node): 300 nodes 1.2 s, 1000 nodes 2.6 s, 2000 nodes 7.0 s, 3000 nodes
 * 13.8 s, 5000 nodes 36 s, 10,000 nodes 123 s. With no edges, 10,000 nodes
 * take 3.5 s; 2000 nodes with 5105 edges, past the edge bound, take 18 s. A tidy
 * of the whole board is 0.3 s at 2000 nodes and 2.1 s at 10,000.
 *
 * So at these bounds the worst board renders in seconds where an unbounded
 * one ran to minutes. 2000 is about seven times the boxes a
 * `wb_canvas_snapshot` read lists, and far past what an agent-drawn board
 * reaches.
 *
 * Counted per canvas because that is what one render pays for. What a
 * workspace holds in all is `WORKSPACE_MAX_DOCUMENTS`' concern.
 *
 * Every keeper and tool holds it to `growsPast`: a canvas stored past either
 * bound still reads, and still takes an edit that adds nothing — removing is
 * how it shrinks.
 */
export const CANVAS_MAX_NODES = 2000

/** See `CANVAS_MAX_NODES`. */
export const CANVAS_MAX_EDGES = 2000

/** The node bound as every refusal of it ends. */
export const CANVAS_NODES_LIMIT_PHRASE = `the ${CANVAS_MAX_NODES}-node limit for one canvas; remove nodes first, or split the board across canvases`

/** The edge bound as every refusal of it ends. */
export const CANVAS_EDGES_LIMIT_PHRASE = `the ${CANVAS_MAX_EDGES}-edge limit for one canvas; remove edges first, or split the board across canvases`
