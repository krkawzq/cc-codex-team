import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration


def _cli(data_dir: Path, sock_path: Path, args: list[str], timeout: int = 60):
    env = os.environ.copy()
    env["XDG_DATA_HOME"] = str(data_dir.parent)
    env["XDG_CONFIG_HOME"] = str(data_dir.parent / "cfg")
    env["XDG_RUNTIME_DIR"] = str(sock_path.parent.parent)
    return subprocess.run(
        [sys.executable, "-m", "codex_team", *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def test_daemon_restart_preserves_session(tmp_path: Path):
    data_dir = tmp_path / "codex-team"
    (tmp_path / "cfg" / "codex-team").mkdir(parents=True)
    sock = tmp_path / "run" / "codex-team" / "daemon.sock"
    sock.parent.mkdir(parents=True)

    assert _cli(data_dir, sock, ["daemon", "start"]).returncode == 0
    assert _cli(data_dir, sock, ["session", "create", "L1", "--cwd", str(tmp_path)]).returncode == 0
    assert _cli(data_dir, sock, ["daemon", "stop"]).returncode == 0
    time.sleep(0.5)
    assert _cli(data_dir, sock, ["daemon", "start"]).returncode == 0
    result = _cli(data_dir, sock, ["session", "status", "L1"])
    assert result.returncode == 0
    assert '"thread_id"' in result.stdout
    _cli(data_dir, sock, ["daemon", "stop"])
