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
