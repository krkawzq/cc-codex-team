import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration


def _run_cli(data_dir: Path, sock_path: Path, args: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
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


def test_create_send_close(tmp_path: Path):
    data_dir = tmp_path / "codex-team"
    (tmp_path / "cfg" / "codex-team").mkdir(parents=True)
    sock_path = tmp_path / "run" / "codex-team" / "daemon.sock"
    sock_path.parent.mkdir(parents=True)

    result = _run_cli(data_dir, sock_path, ["daemon", "start"])
    assert result.returncode == 0, result.stderr
    result = _run_cli(data_dir, sock_path, ["session", "create", "L1", "--cwd", str(tmp_path)])
    assert result.returncode == 0, result.stderr
    result = _run_cli(data_dir, sock_path, ["send", "L1", "Say hi in 5 words."], timeout=120)
    assert result.returncode == 0, result.stderr
    result = _run_cli(data_dir, sock_path, ["session", "close", "L1"])
    assert result.returncode == 0, result.stderr
    result = _run_cli(data_dir, sock_path, ["daemon", "stop"])
    assert result.returncode == 0, result.stderr
