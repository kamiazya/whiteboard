export class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastActivityAt: number

  /**
   * @param busy Whether something is still being served without making
   *   requests — a held stream, an open socket. Asked when the timeout
   *   elapses: a busy daemon waits another timeout rather than stopping,
   *   because "idle" means no client, not no request.
   */
  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
    private readonly now: () => number = () => Date.now(),
    private readonly busy: () => boolean = () => false,
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
      if (this.busy()) {
        this.schedule()
        return
      }
      this.onIdle()
    }, this.timeoutMs)
  }
}
