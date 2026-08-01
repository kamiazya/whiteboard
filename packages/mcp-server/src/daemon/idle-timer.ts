export class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastActivityAt: number

  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastActivityAt = this.now()
  }

  start(): void {
    this.schedule()
  }

  touch(): void {
    this.lastActivityAt = this.now()
    this.schedule()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  getIdleForMs(): number {
    return Math.max(0, this.now() - this.lastActivityAt)
  }

  private schedule(): void {
    this.stop()
    // A non-positive or non-finite timeout means "never idle out" — the dev
    // daemon opts into this (see mcp:http:dev's --idle-timeout-ms=0). It has to
    // be an explicit skip rather than a very large delay: `setTimeout` clamps
    // delays above 2^31-1 ms to fire ~immediately, the opposite of disabling.
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.onIdle()
    }, this.timeoutMs)
  }
}
