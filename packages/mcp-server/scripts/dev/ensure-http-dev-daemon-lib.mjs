export async function waitForAuthenticatedMcp({
  probe,
  sleep,
  timeoutMs,
  pollIntervalMs,
  now = Date.now,
}) {
  const startedAt = now()
  while (now() - startedAt < timeoutMs) {
    if ((await probe()) === 'ours') return true
    await sleep(pollIntervalMs)
  }
  return false
}
