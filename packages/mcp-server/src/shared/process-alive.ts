import { isErrnoCode } from './errno.js'

/**
 * Whether a process with this pid exists.
 *
 * Signal 0 probes without delivering anything. `EPERM` means the process
 * EXISTS and this user may not signal it, so it reads as alive: every caller
 * uses this to refuse something (restoring into a live server's data dir,
 * claiming a lock, starting a second daemon), and wrongly calling a live
 * process dead is the unsafe direction. A non-positive or non-finite pid is
 * dead without asking, because `kill(0, 0)` and `kill(-n, 0)` address a
 * process GROUP, which exists whatever a corrupt record said.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return isErrnoCode(err, 'EPERM')
  }
}
