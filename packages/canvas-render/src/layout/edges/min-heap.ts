/**
 * The smallest binary min-heap a priority search needs, over one numeric
 * priority and one integer payload.
 *
 * Its own module because it was forty lines of index arithmetic inline in
 * `routeOnGrid`, where it could not be read or tested apart from the routing
 * it serves — and where every access needed an `as { cost: number }` cast to
 * get past `noUncheckedIndexedAccess`. Two parallel arrays instead of an
 * array of objects keeps that cast count at zero.
 *
 * Ties are NOT broken: two entries of equal cost pop in whatever order the
 * sift leaves them. That is deliberate and load-bearing — a route search can
 * have several optimal paths, and imposing an order here would silently pick
 * a different one than the code this was extracted from.
 */
export class MinHeap {
  #costs: number[] = []
  #values: number[] = []

  get size(): number {
    return this.#values.length
  }

  push(cost: number, value: number): void {
    this.#costs.push(cost)
    this.#values.push(value)
    let child = this.#values.length - 1
    while (child > 0) {
      const parent = (child - 1) >> 1
      if ((this.#costs[parent] as number) <= (this.#costs[child] as number)) break
      this.#swap(parent, child)
      child = parent
    }
  }

  /** The lowest-cost entry. Undefined only when the heap is empty. */
  pop(): { cost: number; value: number } | undefined {
    if (this.#values.length === 0) return undefined
    const top = { cost: this.#costs[0] as number, value: this.#values[0] as number }
    const lastCost = this.#costs.pop() as number
    const lastValue = this.#values.pop() as number
    if (this.#values.length > 0) {
      this.#costs[0] = lastCost
      this.#values[0] = lastValue
      let parent = 0
      for (;;) {
        const left = parent * 2 + 1
        const right = left + 1
        let smallest = parent
        if (
          left < this.#costs.length &&
          (this.#costs[left] as number) < (this.#costs[smallest] as number)
        )
          smallest = left
        if (
          right < this.#costs.length &&
          (this.#costs[right] as number) < (this.#costs[smallest] as number)
        )
          smallest = right
        if (smallest === parent) break
        this.#swap(parent, smallest)
        parent = smallest
      }
    }
    return top
  }

  #swap(a: number, b: number): void {
    const cost = this.#costs[a] as number
    const value = this.#values[a] as number
    this.#costs[a] = this.#costs[b] as number
    this.#values[a] = this.#values[b] as number
    this.#costs[b] = cost
    this.#values[b] = value
  }
}
