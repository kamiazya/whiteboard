/** The part of a `runtime.Port` the page uses. */
export interface BridgePort {
  readonly onMessage: { addListener(listener: (message: unknown) => void): void }
  readonly onDisconnect: { addListener(listener: () => void): void }
  postMessage(message: unknown): void
  disconnect(): void
}
