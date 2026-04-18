"""codex-team CLI frontend."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

from codex_team.config import load_config, resolve_data_dir, resolve_socket_path
from codex_team.errors import DaemonNotRunning, wire_to_error


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _diagnose_stale_pid(data_dir: Path) -> tuple[bool, int | None, Path]:
    """Return (is_stale, pid, pid_path). Stale = pid file exists but points at dead process."""
    pid_path = data_dir / "daemon.pid"
    if not pid_path.exists():
        return False, None, pid_path
    try:
        pid = int(pid_path.read_text("utf-8").strip())
    except (OSError, ValueError):
        return True, None, pid_path
    if pid <= 0 or not _pid_alive(pid):
        return True, pid, pid_path
    return False, pid, pid_path


def _socket_ready(sock_path: Path) -> bool:
    if not sock_path.exists():
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(0.1)
            client.connect(str(sock_path))
    except OSError:
        return False
    return True


async def _send_request(sock_path: Path, cmd: str, params: dict) -> dict:
    try:
        reader, writer = await asyncio.open_unix_connection(str(sock_path))
    except (FileNotFoundError, ConnectionRefusedError) as exc:
        raise DaemonNotRunning(f"no daemon at {sock_path}") from exc
    request = {"id": str(uuid.uuid4()), "cmd": cmd, "params": params}
    writer.write((json.dumps(request) + "\n").encode("utf-8"))
    await writer.drain()
    line = await reader.readline()
    writer.close()
    await writer.wait_closed()
    if not line:
        raise DaemonNotRunning("daemon closed connection")
    return json.loads(line.decode("utf-8"))


async def _stream_subscribe(sock_path: Path, cmd: str) -> int:
    try:
        reader, writer = await asyncio.open_unix_connection(str(sock_path))
    except (FileNotFoundError, ConnectionRefusedError):
        print("daemon not running", file=sys.stderr)
        return DaemonNotRunning.exit_code
    request = {"id": str(uuid.uuid4()), "cmd": cmd, "params": {}}
    writer.write((json.dumps(request) + "\n").encode("utf-8"))
    await writer.drain()
    try:
        while True:
            line = await reader.readline()
            if not line:
                return 0
            sys.stdout.write(line.decode("utf-8"))
            sys.stdout.flush()
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass


def _follow_file(path: Path, *, start_at_end: bool = False) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=True)
    with path.open("r", encoding="utf-8") as handle:
        if start_at_end:
            handle.seek(0, 2)
        while True:
            line = handle.readline()
            if line:
                sys.stdout.write(line)
                sys.stdout.flush()
                continue
            time.sleep(0.25)


class CliClient:
    def __init__(self, sock_path: Path | None = None) -> None:
        self._sock = sock_path or resolve_socket_path(load_config())
        self._send = _send_request

    def _parse(self, argv: list[str]) -> argparse.Namespace:
        parser = argparse.ArgumentParser(prog="codex-team")
        subparsers = parser.add_subparsers(dest="group", required=True)

        session = subparsers.add_parser("session")
        session_sub = session.add_subparsers(dest="action", required=True)
        create = session_sub.add_parser("create")
        create.add_argument("name")
        create.add_argument("--cwd")
        create.add_argument("--model")
        create.add_argument("--model-provider", dest="model_provider")
        create.add_argument("--sandbox")
        create.add_argument("--approval-policy", dest="approval_policy")
        create.add_argument("--service-tier", dest="service_tier")
        create.add_argument("--reasoning-effort", dest="reasoning_effort")
        create.add_argument("--personality")
        create.add_argument("--profile")
        create.add_argument("--base-instructions-file", dest="base_instructions_file")
        create.add_argument("--developer-instructions-file", dest="developer_instructions_file")
        create.add_argument("--ephemeral", action="store_true")
        session_sub.add_parser("list")
        status = session_sub.add_parser("status")
        status.add_argument("name")
        for action in ("close", "resume", "restart", "kill", "forget", "ack-error", "dump"):
            item = session_sub.add_parser(action)
            item.add_argument("name")

        send = subparsers.add_parser("send")
        send.add_argument("name")
        send.add_argument("text", nargs="?")
        send.add_argument("--stdin", action="store_true")
        send.add_argument("--prompt-file")
        send.add_argument("--wait", action="store_true")
        send.add_argument("--model")
        send.add_argument("--cwd")
        send.add_argument("--effort")
        send.add_argument("--personality")
        send.add_argument("--service-tier", dest="service_tier")
        send.add_argument("--summary")
        send.add_argument("--output-schema-file", dest="output_schema_file")

        for action in ("interrupt", "compact"):
            item = subparsers.add_parser(action)
            item.add_argument("name")

        history = subparsers.add_parser("history")
        history.add_argument("name")
        history.add_argument("--last-n", type=int, default=0)
        history.add_argument("--since")
        history.add_argument("--format", choices=["md", "jsonl"], default="md")

        tail = subparsers.add_parser("tail")
        tail.add_argument("name")
        tail.add_argument("--stderr", action="store_true")

        queue = subparsers.add_parser("queue")
        queue_sub = queue.add_subparsers(dest="action", required=True)
        for action in ("show", "clear", "drop-oldest"):
            item = queue_sub.add_parser(action)
            item.add_argument("name")
        retry_last = queue_sub.add_parser("retry-last")
        retry_last.add_argument("name")
        retry_last.add_argument("--wait", action="store_true")

        health = subparsers.add_parser("health")
        health_sub = health.add_subparsers(dest="action", required=True)
        health_sub.add_parser("check")
        health_sub.add_parser("report")
        health_sub.add_parser("repair")

        daemon = subparsers.add_parser("daemon")
        daemon_sub = daemon.add_subparsers(dest="action", required=True)
        for action in ("start", "stop", "status", "restart", "reload-config"):
            daemon_sub.add_parser(action)
        logs = daemon_sub.add_parser("logs")
        logs.add_argument("--follow", action="store_true")

        monitor = subparsers.add_parser("monitor")
        monitor_sub = monitor.add_subparsers(dest="action", required=True)
        monitor_sub.add_parser("events")
        monitor_sub.add_parser("watchdog")

        return parser.parse_args(argv)

    def _ensure_daemon(self) -> None:
        if _socket_ready(self._sock):
            return
        if self._sock.exists():
            self._sock.unlink()

        cfg = load_config()
        data_dir = resolve_data_dir(cfg)
        data_dir.mkdir(parents=True, exist_ok=True)

        # Pre-flight: stale pid file is by far the most common failure mode.
        # Detect and report it before spawning a doomed child.
        stale, stale_pid, pid_path = _diagnose_stale_pid(data_dir)
        if stale:
            raise DaemonNotRunning(
                f"stale pid file at {pid_path} (pid {stale_pid} is not alive). "
                f"Remove it with: rm -f {pid_path}",
                detail={"pid_path": str(pid_path), "stale_pid": stale_pid},
            )

        # Capture spawned daemon stderr to disk so crash tracebacks are
        # recoverable (subprocess.DEVNULL would make them invisible).
        err_path = data_dir / "daemon-startup.err"
        err_fd = err_path.open("ab", buffering=0)
        try:
            subprocess.Popen(
                [sys.executable, "-m", "codex_team.daemon.main"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=err_fd,
                start_new_session=True,
            )
        finally:
            err_fd.close()

        for _ in range(50):
            if _socket_ready(self._sock):
                return
            time.sleep(0.1)

        # Timed out. Pull the last 40 lines of the startup-err file for
        # the exception detail; that almost always contains the real cause.
        tail = ""
        try:
            if err_path.exists():
                lines = err_path.read_text("utf-8", errors="replace").splitlines()
                tail = "\n".join(lines[-40:])
        except OSError:
            pass

        hint = (
            f"daemon did not become ready at {self._sock}. "
            f"Check {err_path} for the spawned daemon's stderr."
        )
        if tail:
            hint += f"\n--- last stderr lines ---\n{tail}\n--- end ---"
        raise DaemonNotRunning(
            hint,
            detail={
                "socket_path": str(self._sock),
                "startup_err_path": str(err_path),
                "startup_err_tail": tail,
            },
        )

    def _read_prompt(self, args: argparse.Namespace) -> str:
        if args.stdin:
            return sys.stdin.read()
        if args.prompt_file:
            return Path(args.prompt_file).read_text("utf-8")
        return args.text or ""

    def _read_optional_file(self, value: str | None) -> str | None:
        if not value:
            return None
        return Path(value).read_text("utf-8")

    def _handle(self, args: argparse.Namespace) -> dict:
        cmd: str | None = None
        params: dict = {}
        if args.group == "session":
            cmd = f"session.{args.action.replace('-', '_')}"
            if getattr(args, "name", None) is not None:
                params["name"] = args.name
            if args.action == "create":
                for key in (
                    "cwd",
                    "model",
                    "model_provider",
                    "sandbox",
                    "approval_policy",
                    "service_tier",
                    "reasoning_effort",
                    "personality",
                    "profile",
                ):
                    value = getattr(args, key, None)
                    if value is not None:
                        params[key] = value
                params["base_instructions"] = self._read_optional_file(args.base_instructions_file)
                params["developer_instructions"] = self._read_optional_file(args.developer_instructions_file)
                params["ephemeral"] = bool(args.ephemeral)
        elif args.group == "send":
            output_schema = None
            if args.output_schema_file:
                output_schema = json.loads(Path(args.output_schema_file).read_text("utf-8"))
            cmd = "send"
            params = {
                "name": args.name,
                "text": self._read_prompt(args),
                "wait": args.wait,
                "model": args.model,
                "cwd": args.cwd,
                "effort": args.effort,
                "personality": args.personality,
                "service_tier": args.service_tier,
                "summary": args.summary,
                "output_schema": output_schema,
            }
        elif args.group == "interrupt":
            cmd = "interrupt"
            params = {"name": args.name}
        elif args.group == "compact":
            cmd = "compact"
            params = {"name": args.name}
        elif args.group == "history":
            cmd = "history.get"
            params = {"name": args.name, "last_n": args.last_n, "since": args.since, "format": args.format}
        elif args.group == "tail":
            cmd = "history.tail_stderr"
            params = {"name": args.name, "lines": 200}
        elif args.group == "queue":
            cmd = f"queue.{args.action.replace('-', '_')}"
            params = {"name": args.name}
            if hasattr(args, "wait"):
                params["wait"] = bool(args.wait)
        elif args.group == "health":
            cmd = f"health.{args.action}"
        elif args.group == "daemon":
            if args.action == "start":
                self._ensure_daemon()
                return {"ok": True, "data": {"started": True}}
            if args.action == "restart":
                try:
                    asyncio.run(self._send(self._sock, "daemon.stop", {}))
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(0.3)
                self._ensure_daemon()
                return {"ok": True, "data": {"restarted": True}}
            if args.action == "logs" and args.follow:
                cfg = load_config()
                log_path = resolve_data_dir(cfg) / "daemon.log"
                _follow_file(log_path)
                return {"ok": True, "data": {"followed": True}}
            cmd = f"daemon.{args.action.replace('-', '_')}"
        elif args.group == "monitor":
            return {"_stream": f"monitor.{args.action}.subscribe"}

        if cmd is None:
            return {"ok": False, "error": {"code": "E_INVALID", "msg": "unhandled command", "detail": {}}}
        return asyncio.run(self._send(self._sock, cmd, params))

    def run(self, argv: list[str] | None = None) -> int:
        args = self._parse(argv if argv is not None else sys.argv[1:])
        if args.group == "monitor":
            self._ensure_daemon()
            return asyncio.run(_stream_subscribe(self._sock, f"monitor.{args.action}.subscribe"))

        if not (args.group == "daemon" and args.action in {"start", "restart"}):
            self._ensure_daemon()
        response = self._handle(args)
        if response.get("ok"):
            sys.stdout.write(json.dumps(response.get("data", {}), indent=2) + "\n")
            return 0
        error = wire_to_error(response.get("error") or {})
        sys.stderr.write(f"codex-team: {error.code}: {error}\n")
        if error.detail:
            sys.stderr.write(f"  detail: {json.dumps(error.detail)}\n")
        return error.exit_code


def main(argv: list[str] | None = None) -> int:
    return CliClient().run(argv)
