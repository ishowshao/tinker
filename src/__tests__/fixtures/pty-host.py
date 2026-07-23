import argparse
import errno
import fcntl
import json
import os
import pty
import select
import signal
import socket
import struct
import sys
import termios
import time
from typing import Optional


HOST_TERMINATION_GRACE_SECONDS = 0.75
CHILD_EXIT_ACK_TIMEOUT_SECONDS = 1.0


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        usage=(
            "pty-host.py [--rows ROWS] [--columns COLUMNS] "
            "--control-socket PATH -- command [args...]"
        )
    )
    parser.add_argument("--rows", type=positive_integer, default=30)
    parser.add_argument("--columns", type=positive_integer, default=120)
    parser.add_argument("--control-socket", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    if arguments.command[:1] == ["--"]:
        arguments.command = arguments.command[1:]
    if not arguments.command:
        parser.error("a child command is required")
    return arguments


def write_all(file_descriptor: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        offset += os.write(file_descriptor, data[offset:])


def send_control(
    control_socket: socket.socket,
    message: dict[str, object],
) -> None:
    encoded = (
        json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    control_socket.sendall(encoded)


def set_window_size(file_descriptor: int, rows: int, columns: int) -> None:
    fcntl.ioctl(
        file_descriptor,
        termios.TIOCSWINSZ,
        struct.pack("HHHH", rows, columns, 0, 0),
    )


def child_exit_message(status: int) -> dict[str, object]:
    if os.WIFEXITED(status):
        return {
            "op": "child_exit",
            "code": os.WEXITSTATUS(status),
            "signal": None,
        }
    signal_name = signal.Signals(os.WTERMSIG(status)).name
    return {
        "op": "child_exit",
        "code": None,
        "signal": signal_name,
    }


def child_return_code(status: int) -> int:
    exit_code = os.waitstatus_to_exitcode(status)
    if exit_code >= 0:
        return exit_code
    return 128 + -exit_code


def kill_process_group(child_pid: int, signal_number: int) -> None:
    try:
        os.killpg(child_pid, signal_number)
    except ProcessLookupError:
        pass


def reap_after_forced_cleanup(child_pid: int) -> Optional[int]:
    kill_process_group(child_pid, signal.SIGKILL)
    try:
        _, status = os.waitpid(child_pid, 0)
        return status
    except ChildProcessError:
        return None


def control_error(
    control_socket: socket.socket,
    request_id: object,
    error: str,
) -> None:
    send_control(
        control_socket,
        {"id": request_id, "ok": False, "error": error},
    )


def handle_control_message(
    control_socket: socket.socket,
    message: object,
    child_pid: int,
    master_fd: int,
    child_running: bool,
) -> bool:
    if not isinstance(message, dict):
        control_error(
            control_socket,
            None,
            "control message must be a JSON object",
        )
        return False

    request_id = message.get("id")
    operation = message.get("op")
    if operation == "ack_child_exit":
        return True
    if not child_running:
        control_error(
            control_socket,
            request_id,
            "Tinker child has already exited",
        )
        return False

    if operation == "resize":
        rows = message.get("rows")
        columns = message.get("columns")
        if (
            not isinstance(rows, int)
            or isinstance(rows, bool)
            or rows <= 0
            or not isinstance(columns, int)
            or isinstance(columns, bool)
            or columns <= 0
        ):
            control_error(
                control_socket,
                request_id,
                "resize requires positive rows and columns",
            )
            return False
        set_window_size(master_fd, rows, columns)
        kill_process_group(child_pid, signal.SIGWINCH)
        send_control(
            control_socket,
            {
                "id": request_id,
                "ok": True,
                "op": "resize",
                "rows": rows,
                "columns": columns,
            }
        )
        return False

    if operation == "signal_child":
        signal_name = message.get("signal")
        if not isinstance(signal_name, str):
            control_error(
                control_socket,
                request_id,
                "signal_child requires a signal name",
            )
            return False
        try:
            signal_number = signal.Signals[signal_name].value
        except KeyError:
            control_error(
                control_socket,
                request_id,
                f"unknown signal: {signal_name}",
            )
            return False
        send_control(
            control_socket,
            {
                "id": request_id,
                "ok": True,
                "op": "signal_child",
                "signal": signal_name,
            }
        )
        kill_process_group(child_pid, signal_number)
        return False

    control_error(
        control_socket,
        request_id,
        f"unknown control operation: {operation}",
    )
    return False


def main() -> int:
    arguments = parse_arguments()
    control_listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    control_listener.bind(arguments.control_socket)
    os.chmod(arguments.control_socket, 0o600)
    control_listener.listen(1)
    control_listener.settimeout(0.05)

    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        control_listener.close()
        set_window_size(sys.stdout.fileno(), arguments.rows, arguments.columns)
        os.execvpe(arguments.command[0], arguments.command, os.environ)

    set_window_size(master_fd, arguments.rows, arguments.columns)
    host_signal = None

    def request_termination(signal_number: int, _frame: object) -> None:
        nonlocal host_signal
        if host_signal is None:
            host_signal = signal_number

    signal.signal(signal.SIGINT, request_termination)
    signal.signal(signal.SIGTERM, request_termination)
    signal.signal(signal.SIGHUP, request_termination)

    control_socket = None
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_open = True
    control_open = False
    master_open = True
    control_buffer = b""
    child_status = None
    termination_started_at = None
    sent_sigkill = False
    child_exit_sent_at = None
    child_exit_acknowledged = False

    try:
        while control_socket is None and host_signal is None:
            try:
                control_socket, _ = control_listener.accept()
            except socket.timeout:
                continue
        if control_socket is None:
            reap_after_forced_cleanup(child_pid)
            return 128 + (host_signal or signal.SIGTERM)
        control_open = True
        send_control(
            control_socket,
            {
                "op": "ready",
                "childPid": child_pid,
                "rows": arguments.rows,
                "columns": arguments.columns,
            }
        )
        while True:
            if child_status is not None and not master_open:
                if (
                    not control_open
                    or child_exit_acknowledged
                    or (
                        child_exit_sent_at is not None
                        and time.monotonic() - child_exit_sent_at
                        >= CHILD_EXIT_ACK_TIMEOUT_SECONDS
                    )
                ):
                    break

            if host_signal is not None and master_open:
                if termination_started_at is None:
                    kill_process_group(child_pid, signal.SIGTERM)
                    termination_started_at = time.monotonic()
                elif (
                    not sent_sigkill
                    and time.monotonic() - termination_started_at
                    >= HOST_TERMINATION_GRACE_SECONDS
                ):
                    kill_process_group(child_pid, signal.SIGKILL)
                    sent_sigkill = True

            watched = []
            if master_open:
                watched.append(master_fd)
            if stdin_open:
                watched.append(stdin_fd)
            if control_open:
                watched.append(control_socket)
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

            if control_open and control_socket in readable:
                data = control_socket.recv(65536)
                if data:
                    control_buffer += data
                    while b"\n" in control_buffer:
                        line, control_buffer = control_buffer.split(b"\n", 1)
                        if not line:
                            continue
                        try:
                            message = json.loads(line.decode("utf-8"))
                        except (UnicodeDecodeError, json.JSONDecodeError) as error:
                            control_error(
                                control_socket,
                                None,
                                f"invalid control JSON: {error}",
                            )
                            continue
                        child_exit_acknowledged = (
                            handle_control_message(
                                control_socket,
                                message,
                                child_pid,
                                master_fd,
                                child_status is None,
                            )
                            or child_exit_acknowledged
                        )
                else:
                    control_open = False

            if master_open and master_fd in readable:
                try:
                    data = os.read(master_fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    write_all(stdout_fd, data)
                else:
                    master_open = False

            if child_status is None:
                waited_pid, status = os.waitpid(child_pid, os.WNOHANG)
                if waited_pid == child_pid:
                    child_status = status
                    if control_open:
                        send_control(
                            control_socket,
                            child_exit_message(status),
                        )
                        child_exit_sent_at = time.monotonic()
    except BaseException:
        kill_process_group(child_pid, signal.SIGKILL)
        if child_status is None:
            child_status = reap_after_forced_cleanup(child_pid)
        raise
    finally:
        if master_open:
            os.close(master_fd)
        if control_socket is not None:
            control_socket.close()
        control_listener.close()
        try:
            os.unlink(arguments.control_socket)
        except FileNotFoundError:
            pass

    if child_status is None:
        _, child_status = os.waitpid(child_pid, 0)
    if host_signal is not None:
        return 128 + host_signal
    return child_return_code(child_status)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BaseException as error:
        if not isinstance(error, SystemExit):
            print(f"pty-host error: {error}", file=sys.stderr, flush=True)
        raise
