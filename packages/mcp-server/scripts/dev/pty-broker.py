#!/usr/bin/env python3
"""Allocate a real pseudo-terminal for a child process's stdio.

`whiteboard daemon run`'s auto-open-browser guard checks
`process.stdout.isTTY`, which Node only sets when its stdout file
descriptor is a real terminal device. A plain `child_process.spawn` with
piped stdio can never satisfy that guard. Wrapping tools that rely on an
*inherited* controlling terminal (e.g. macOS/BSD `script(1)`) do not help
either in a sandboxed test harness, because the harness's own stdio is
frequently not a tty. `os.forkpty()` allocates a pty unconditionally via
the same syscall a real terminal emulator uses, independent of the
parent's own tty status, which is why it's used here instead.

Usage: pty-broker.py --pidfile <path> -- <command> [args...]

Writes the forked child's pid to --pidfile immediately (before exec) so
the caller can signal the real command process directly (SIGTERM/SIGKILL)
without depending on this broker to forward signals. Forwards all pty
output (stdout+stderr are the same fd once attached to a pty) to this
process's own stdout.
"""

import argparse
import os
import pty
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--pidfile", required=True)
parser.add_argument("cmd", nargs=argparse.REMAINDER)
args = parser.parse_args()

cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
if not cmd:
    sys.exit("pty-broker: no command given")

pid, master_fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
    # execvp only returns on failure.
    os._exit(127)

with open(args.pidfile, "w", encoding="utf-8") as pidfile:
    pidfile.write(str(pid))

try:
    while True:
        try:
            data = os.read(master_fd, 4096)
        except OSError:
            break
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
finally:
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
