import asyncio
import json
from pathlib import Path

import pytest

from codex_team.cli import CliClient, _send_request


@pytest.mark.asyncio
async def test_send_request_encodes_and_decodes(tmp_path: Path):
    sock = tmp_path / "s.sock"

    async def echo(reader, writer):
        line = await reader.readline()
        data = json.loads(line.decode())
        response = {"id": data["id"], "ok": True, "data": {"echo": data.get("cmd")}}
        writer.write((json.dumps(response) + "\n").encode())
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(echo, path=str(sock))
    try:
        response = await _send_request(sock, "hello.world", {"x": 1})
        assert response["ok"] is True
        assert response["data"]["echo"] == "hello.world"
    finally:
        server.close()
        await server.wait_closed()


def test_cli_client_error_maps_to_exit_code(tmp_path: Path, capsys):
    async def fake_send(_sock, _cmd, _params):
        return {"ok": False, "error": {"code": "E_NOT_FOUND", "msg": "nope", "detail": {}}}

    client = CliClient(sock_path=tmp_path / "s.sock")
    client._send = fake_send
    client._ensure_daemon = lambda: None
    exit_code = client.run(["session", "status", "A"])
    captured = capsys.readouterr()
    assert exit_code == 3
    assert "nope" in captured.err


def test_cli_parses_history_subcommand(tmp_path: Path):
    client = CliClient(sock_path=tmp_path / "s.sock")
    namespace = client._parse(["history", "A", "--last-n", "3"])
    assert namespace.group == "history"
    assert namespace.name == "A"
    assert namespace.last_n == 3


def test_cli_parses_health_subcommand(tmp_path: Path):
    client = CliClient(sock_path=tmp_path / "s.sock")
    namespace = client._parse(["health", "check"])
    assert namespace.group == "health"
    assert namespace.action == "check"


def test_ensure_daemon_unlinks_stale_socket(tmp_path: Path, monkeypatch):
    sock = tmp_path / "daemon.sock"
    sock.write_text("", "utf-8")
    calls = {"popen": 0, "ready": 0}

    def fake_ready(_sock_path):
        calls["ready"] += 1
        return calls["ready"] >= 2

    class DummyProc:
        pass

    def fake_popen(*args, **kwargs):
        calls["popen"] += 1
        sock.write_text("", "utf-8")
        return DummyProc()

    monkeypatch.setattr("codex_team.cli._socket_ready", fake_ready)
    monkeypatch.setattr("codex_team.cli.subprocess.Popen", fake_popen)
    monkeypatch.setattr("codex_team.cli.time.sleep", lambda _seconds: None)

    client = CliClient(sock_path=sock)
    client._ensure_daemon()
    assert calls["popen"] == 1


def test_cli_parses_profile_and_send_overrides(tmp_path: Path):
    client = CliClient(sock_path=tmp_path / "s.sock")
    namespace = client._parse(
        ["session", "create", "A", "--profile", "reviewer", "--reasoning-effort", "high"]
    )
    assert namespace.profile == "reviewer"
    assert namespace.reasoning_effort == "high"

    namespace = client._parse(
        ["send", "A", "hello", "--model", "gpt-5.4-mini", "--effort", "high", "--service-tier", "priority"]
    )
    assert namespace.model == "gpt-5.4-mini"
    assert namespace.effort == "high"
    assert namespace.service_tier == "priority"
