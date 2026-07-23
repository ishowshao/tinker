import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def write_all(file_descriptor: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        offset += os.write(file_descriptor, data[offset:])


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: pty-host.py <command> [args...]")

    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

    fcntl.ioctl(
        master_fd,
        termios.TIOCSWINSZ,
        struct.pack("HHHH", 30, 120, 0, 0),
    )

    def terminate(_signal_number: int, _frame: object) -> None:
        try:
            os.killpg(child_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os._exit(1)

    signal.signal(signal.SIGINT, terminate)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGHUP, terminate)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_open = True
    child_status = None

    while True:
        watched = [master_fd]
        if stdin_open:
            watched.append(stdin_fd)
        readable, _, _ = select.select(watched, [], [], 0.05)

        if stdin_open and stdin_fd in readable:
            data = os.read(stdin_fd, 65536)
            if data:
                try:
                    write_all(master_fd, data)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
            else:
                stdin_open = False

        if master_fd in readable:
            try:
                data = os.read(master_fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            write_all(stdout_fd, data)

        if child_status is None:
            waited_pid, status = os.waitpid(child_pid, os.WNOHANG)
            if waited_pid == child_pid:
                child_status = status

    os.close(master_fd)
    if child_status is None:
        _, child_status = os.waitpid(child_pid, 0)
    return os.waitstatus_to_exitcode(child_status)


if __name__ == "__main__":
    raise SystemExit(main())
