//! Line jumps: where one routed edge crosses an earlier one, the later edge
//! hops over it (canvas-render's `layout/edges/edge-jumps.ts`). The broad
//! phase that finds which runs can meet is [`grid`].

pub mod grid;
