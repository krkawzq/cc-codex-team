import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration


def _env(data_dir: Path, sock: Path):
    env = os.environ.copy()
    env["XDG_DATA_HOME"] = str(data_dir.parent)
    env["XDG_CONFIG_HOME"] = str(data_dir.parent / "cfg")
    env["XDG_RUNTIME_DIR"] = str(sock.parent.parent)
    return env


def test_events_stream_yields_turn_done(tmp_path: Path):
    data_dir = tmp_path / "codex-team"
    (tmp_path / "cfg" / "codex-team").mkdir(parents=True)
    sock = tmp_path / "run" / "codex-team" / "daemon.sock"
    sock.parent.mkdir(parents=True)
    env = _env(data_dir, sock)

    subprocess.run([sys.executable, "-m", "codex_team", "daemon", "start"], env=env, check=True, timeout=30)
    subprocess.run(
        [sys.executable, "-m", "codex_team", "session", "create", "L1", "--cwd", str(tmp_path)],
        env=env,
        check=True,
        timeout=30,
    )

    process = subprocess.Popen(
        [sys.executable, "-m", "codex_team", "monitor", "events"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    subprocess.run([sys.executable, "-m", "codex_team", "send", "L1", "say hi"], env=env, check=True, timeout=120)

    deadline = time.time() + 120
    saw = False
    while time.time() < deadline:
        line = process.stdout.readline()
        if not line:
            time.sleep(0.1)
            continue
        event = json.loads(line)
        if event["payload"].get("kind") in {"turn-done", "turn-attn"}:
            saw = True
            break

    process.kill()
    subprocess.run([sys.executable, "-m", "codex_team", "daemon", "stop"], env=env, timeout=30)
    assert saw, "did not observe turn-done event on stream"
