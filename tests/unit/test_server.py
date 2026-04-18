import asyncio
import json
from pathlib import Path

import pytest

from codex_team.config import Config
from codex_team.daemon.server import DaemonServer
from codex_team.schemas.registry import SessionStatus
from tests.fakes import FakeAsyncCodex


async def _send_recv(sock_path: Path, request: dict) -> dict:
    reader, writer = await asyncio.open_unix_connection(str(sock_path))
    writer.write((json.dumps(request) + "\n").encode())
    await writer.drain()
    line = await reader.readline()
    writer.close()
    await writer.wait_closed()
    return json.loads(line.decode())


@pytest.mark.asyncio
async def test_server_creates_and_lists_session(tmp_path: Path):
    cfg = Config()
    cfg.daemon.data_dir = str(tmp_path)
    sock = tmp_path / "daemon.sock"
    server = DaemonServer(cfg=cfg, socket_path=sock, codex_factory=lambda **_: FakeAsyncCodex())
    await server.start()
    try:
        response = await _send_recv(sock, {"id": "r1", "cmd": "session.create", "params": {"name": "A"}})
        assert response["ok"] is True
        response = await _send_recv(sock, {"id": "r2", "cmd": "session.list", "params": {}})
        assert response["ok"] is True
        assert response["data"]["sessions"][0]["name"] == "A"
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_server_returns_error_for_unknown_command(tmp_path: Path):
    cfg = Config()
    cfg.daemon.data_dir = str(tmp_path)
    sock = tmp_path / "daemon.sock"
    server = DaemonServer(cfg=cfg, socket_path=sock, codex_factory=lambda **_: FakeAsyncCodex())
    await server.start()
    try:
        response = await _send_recv(sock, {"id": "r1", "cmd": "unknown.cmd", "params": {}})
        assert response["ok"] is False
        assert response["error"]["code"] == "E_INVALID"
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_server_stop_preserves_session_for_future_resume(tmp_path: Path):
    cfg = Config()
    cfg.daemon.data_dir = str(tmp_path)
    sock = tmp_path / "daemon.sock"
    server = DaemonServer(cfg=cfg, socket_path=sock, codex_factory=lambda **_: FakeAsyncCodex())
    await server.start()
    try:
        response = await _send_recv(sock, {"id": "r1", "cmd": "session.create", "params": {"name": "A"}})
        assert response["ok"] is True
    finally:
        await server.stop()

    # daemon shutdown should not mark sessions as explicitly closed
    restarted = DaemonServer(cfg=cfg, socket_path=sock, codex_factory=lambda **_: FakeAsyncCodex())
    try:
        assert restarted.registry.get("A").status != SessionStatus.closed
    finally:
        await restarted.stop()


@pytest.mark.asyncio
async def test_server_health_report_and_dump(tmp_path: Path):
    cfg = Config()
    cfg.daemon.data_dir = str(tmp_path)
    sock = tmp_path / "daemon.sock"
    server = DaemonServer(cfg=cfg, socket_path=sock, codex_factory=lambda **_: FakeAsyncCodex())
    await server.start()
    try:
        response = await _send_recv(sock, {"id": "r1", "cmd": "session.create", "params": {"name": "A"}})
        assert response["ok"] is True
        report = await _send_recv(sock, {"id": "r2", "cmd": "health.report", "params": {}})
        assert report["ok"] is True
        assert report["data"]["sessions"][0]["name"] == "A"
        dump = await _send_recv(sock, {"id": "r3", "cmd": "session.dump", "params": {"name": "A"}})
        assert dump["ok"] is True
        assert dump["data"]["session"]["name"] == "A"
    finally:
        await server.stop()
