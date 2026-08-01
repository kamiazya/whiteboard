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
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // A non-positive or non-finite timeout means "never idle out" — the dev
    // daemon opts into this (see mcp:http:dev's --idle-timeout-ms=0) so a
    // 15-minute-idle dev session doesn't silently self-terminate. `setTimeout`
    // clamps any delay above 2^31-1 ms to effectively immediate firing, so a
    // "very large number" sentinel would do the opposite of disabling —
    // this has to be an explicit skip, not a large delay.
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.onIdle()
    }, this.timeoutMs)
  }
}
