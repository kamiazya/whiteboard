// Best-effort container detection for the daemon's auto-open-browser guard.
// A browser popup is meaningless inside a container (no display server on
// the other side of `open()`), so the daemon must recognize the common
// container runtimes even though none of them expose a single canonical
// signal.

import { existsSync, readFileSync } from 'node:fs'

const CONTAINER_CGROUP_PATTERN = /docker|kubepods|containerd|libpod/

export interface ContainerDetectionDeps {
  /** Docker (and Docker-compatible runtimes) bind-mount this file into every container. */
  hasDockerEnvFile: () => boolean
  /** PID 1's cgroup membership; container runtimes tag their slice/scope names. */
  readCgroup: () => string | undefined
}

function defaultHasDockerEnvFile(): boolean {
  return existsSync('/.dockerenv')
}

function defaultReadCgroup(): string | undefined {
  try {
    return readFileSync('/proc/1/cgroup', 'utf8')
  } catch {
    return undefined
  }
}

export const defaultContainerDetectionDeps: ContainerDetectionDeps = {
  hasDockerEnvFile: defaultHasDockerEnvFile,
  readCgroup: defaultReadCgroup,
}

export function isRunningInContainer(
  env: Readonly<Record<string, string | undefined>>,
  deps: ContainerDetectionDeps = defaultContainerDetectionDeps,
): boolean {
  // Podman and systemd-nspawn set this env var directly inside the container;
  // Docker does not, which is why the /.dockerenv and cgroup checks below
  // still matter.
  if (env.container !== undefined) return true
  if (deps.hasDockerEnvFile()) return true
  const cgroup = deps.readCgroup()
  if (cgroup !== undefined && CONTAINER_CGROUP_PATTERN.test(cgroup)) return true
  return false
}
