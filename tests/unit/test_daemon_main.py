import asyncio
import json
import os
from pathlib import Path

import pytest

from codex_team.config import Config
from codex_team.daemon.main import _serve, acquire_pid_lock, release_pid_lock
from codex_team.errors import DaemonAlreadyRunning


def test_acquire_and_release(tmp_path: Path):
    pid_file = tmp_path / "d.pid"
    acquire_pid_lock(pid_file)
    assert pid_file.read_text().strip() == str(os.getpid())
    release_pid_lock(pid_file)
    assert not pid_file.exists()


def test_stale_lock_is_reclaimed(tmp_path: Path):
    pid_file = tmp_path / "d.pid"
    pid_file.write_text("999999999")
    acquire_pid_lock(pid_file)
    assert pid_file.read_text().strip() == str(os.getpid())
    release_pid_lock(pid_file)


def test_live_lock_raises(tmp_path: Path, monkeypatch):
    pid_file = tmp_path / "d.pid"
    pid_file.write_text(str(os.getpid()))
    from codex_team.daemon import main as daemon_main

    monkeypatch.setattr(daemon_main, "_is_alive", lambda _pid: True)
    with pytest.raises(DaemonAlreadyRunning):
        acquire_pid_lock(pid_file)


@pytest.mark.asyncio
async def test_daemon_stop_request_exits_serve_loop(tmp_path: Path):
    cfg = Config()
    cfg.daemon.data_dir = str(tmp_path / "data")
    cfg.daemon.socket_path = str(tmp_path / "daemon.sock")
    cfg.defaults.auto_resume_on_daemon_start = False
    pid_file = tmp_path / "daemon.pid"
    pid_file.write_text(str(os.getpid()), "utf-8")

    task = asyncio.create_task(_serve(cfg, pid_file))
    try:
        deadline = asyncio.get_running_loop().time() + 5
        while not Path(cfg.daemon.socket_path).exists():
            if asyncio.get_running_loop().time() > deadline:
                raise AssertionError("daemon socket was not created")
            await asyncio.sleep(0.01)

        reader, writer = await asyncio.open_unix_connection(cfg.daemon.socket_path)
        writer.write(json.dumps({"id": "stop", "cmd": "daemon.stop", "params": {}}).encode() + b"\n")
        await writer.drain()
        response = json.loads((await reader.readline()).decode("utf-8"))
        writer.close()
        await writer.wait_closed()

        assert response["ok"] is True
        await asyncio.wait_for(task, timeout=5)
        assert not pid_file.exists()
        assert not Path(cfg.daemon.socket_path).exists()
    finally:
        if not task.done():
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
