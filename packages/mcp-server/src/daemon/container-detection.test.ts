import { describe, expect, it } from 'vitest'
import { isRunningInContainer } from './container-detection.js'

describe('isRunningInContainer', () => {
  it('returns false when no container signal is present', () => {
    const result = isRunningInContainer(
      {},
      { hasDockerEnvFile: () => false, readCgroup: () => undefined },
    )
    expect(result).toBe(false)
  })

  it('returns true when the `container` env var is set (Podman / systemd-nspawn)', () => {
    const result = isRunningInContainer(
      { container: 'podman' },
      { hasDockerEnvFile: () => false, readCgroup: () => undefined },
    )
    expect(result).toBe(true)
  })

  it('returns true when /.dockerenv exists', () => {
    const result = isRunningInContainer(
      {},
      { hasDockerEnvFile: () => true, readCgroup: () => undefined },
    )
    expect(result).toBe(true)
  })

  it('returns true when /proc/1/cgroup mentions docker', () => {
    const result = isRunningInContainer(
      {},
      { hasDockerEnvFile: () => false, readCgroup: () => '0::/docker/abc123' },
    )
    expect(result).toBe(true)
  })

  it('returns true when /proc/1/cgroup mentions kubepods', () => {
    const result = isRunningInContainer(
      {},
      { hasDockerEnvFile: () => false, readCgroup: () => '0::/kubepods/besteffort/pod1' },
    )
    expect(result).toBe(true)
  })

  it('returns false for an unrelated cgroup line', () => {
    const result = isRunningInContainer(
      {},
      { hasDockerEnvFile: () => false, readCgroup: () => '0::/user.slice/user-1000.slice' },
    )
    expect(result).toBe(false)
  })
})
