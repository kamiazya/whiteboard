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
    this.timer = setTimeout(() => {
      this.timer = null
      this.onIdle()
    }, this.timeoutMs)
  }
}
