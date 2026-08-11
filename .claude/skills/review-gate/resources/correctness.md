# Correctness

Logic errors that compile and pass a happy-path test but misbehave on real
inputs.

## Criteria

### 1. Unhandled null/undefined

Check:
- Does the diff dereference a value that can be `null`/`undefined` at
  runtime (an optional field, a failed lookup, an empty array's `[0]`)
  without a guard?

### 2. Off-by-one and boundary conditions

Check:
- Do loop bounds, slice/substring indices, or pagination offsets handle the
  first/last element and the empty-collection case correctly?

### 3. Error propagation

Check:
- Does a caught error get logged/handled and then silently swallowed, or is
  it re-thrown/surfaced so the caller can react?
- Does an `async` function's rejected promise get awaited/caught, or can it
  become an unhandled rejection?

### 4. Type unsoundness

Check:
- Does a type assertion (`as X`) or generic cast paper over a real
  mismatch between the asserted type and the actual runtime shape?

### 5. Immutable-update discipline

Check:
- Does the diff mutate an input object/array in place instead of returning
  a new copy, in a codebase that mandates immutable updates?

### 6. Concurrency/ordering assumptions

Check:
- Does the diff assume a particular resolution order for parallel
  promises, websocket messages, or persistence writes that isn't actually
  guaranteed?

### 7. Cross-feature semantic invariants

Feature-level bugs recur where a change meets a cross-cutting concept the
diff never names. When the diff touches the spatial editor or renderer,
check it against the concepts it intersects:

- **Containers/groups**: membership is geometric (no parent pointer). A
  rule quantified over "all nodes" must not accidentally include a
  container that encloses the operands (e.g. an obstacle set, a snap set,
  a carry set). An edge between two members runs inside the frame.
- **Selection**: the selection is always `{primary} ∪ extras` with the
  primary never inside extras. Any path that changes one side of that
  pair (promotion, collapse, marquee, menu) must keep the pair coherent —
  an invariant maintained per call site instead of by construction is the
  defect shape.
- **Z-order vs visibility**: group frames are unfilled, so paint order
  does not equal occlusion. "You can act on what you can see" beats raw
  topmost-wins wherever the two disagree.
- **Hit-testing vs painted geometry**: whatever is drawn (a rounded
  curve, a detoured path) is what must be hit-tested and highlighted —
  two producers of the same geometry is the drift class the Zod
  discipline exists for, applied to pixels.

### 8. Overlay declares its own surface

Check:
- Does the diff add an absolutely-positioned overlay (input, editor,
  toolbar) over canvas content without declaring its own opaque
  background and typography? The CSS reset makes form controls
  transparent, so an unstyled overlay lets the content underneath show
  through the draft.
