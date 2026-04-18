"""Daemon entrypoint with pid lock and signal handling."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from pathlib import Path

from codex_team.config import Config, load_config, resolve_data_dir, resolve_socket_path
from codex_team.daemon.server import DaemonServer
from codex_team.errors import DaemonAlreadyRunning
from codex_team.paths import xdg_config_dir


def _append_log_line(log_path: Path, message: str) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(f"{message}\n")


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def acquire_pid_lock(pid_path: Path) -> None:
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    if pid_path.exists():
        try:
            pid = int(pid_path.read_text("utf-8").strip())
        except ValueError:
            pid = -1
        if pid > 0 and _is_alive(pid):
            raise DaemonAlreadyRunning(
                f"another daemon is already running (pid={pid}, pid_file={pid_path}). "
                f"If this is unexpected, inspect with `ps -fp {pid}` and, if that "
                f"process is orphaned / not serving, `kill -9 {pid} && rm -f {pid_path}` "
                f"before restarting."
            )
        pid_path.unlink()
    pid_path.write_text(str(os.getpid()), "utf-8")


def release_pid_lock(pid_path: Path) -> None:
    if pid_path.exists():
        try:
            pid_path.unlink()
        except FileNotFoundError:
            pass


async def _serve(cfg: Config, pid_path: Path) -> None:
    data_dir = resolve_data_dir(cfg)
    cfg.daemon.data_dir = str(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    log_path = data_dir / "daemon.log"
    logging.basicConfig(
        filename=str(log_path),
        level=getattr(logging, cfg.daemon.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
        force=True,
    )
    _append_log_line(log_path, "daemon starting")
    socket_path = resolve_socket_path(cfg)
    stop_event = asyncio.Event()
    server = DaemonServer(cfg=cfg, socket_path=socket_path, shutdown_callback=stop_event.set)
    logging.info("starting daemon on %s", socket_path)
    await server.start()

    if cfg.defaults.auto_resume_on_daemon_start:
        for entry in server.registry.list():
            if entry.status.value in {"idle", "running", "errored", "compacting"}:
                try:
                    server.sessions[entry.name] = await server.factory.resume(entry.name)
                except Exception:
                    logging.exception("failed to auto-resume session %s", entry.name)
                    continue

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:  # pragma: no cover
            pass

    await stop_event.wait()
    logging.info("stopping daemon")
    await server.stop()
    _append_log_line(log_path, "daemon stopped")
    release_pid_lock(pid_path)


def run(config_path: Path | None = None) -> int:
    cfg = load_config(config_path or (xdg_config_dir() / "config.toml"))
    pid_path = resolve_data_dir(cfg) / "daemon.pid"
    acquire_pid_lock(pid_path)
    try:
        asyncio.run(_serve(cfg, pid_path))
    finally:
        release_pid_lock(pid_path)
    return 0


def main() -> int:
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
