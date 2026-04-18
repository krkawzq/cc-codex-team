"""XDG-aware path resolution helpers."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

_APP = "codex-team"


def _home() -> Path:
    return Path(os.environ.get("HOME", "/"))


def xdg_config_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(_home() / ".config")
    return Path(base) / _APP


def xdg_data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or str(_home() / ".local/share")
    return Path(base) / _APP


def xdg_runtime_dir() -> Path:
    base = os.environ.get("XDG_RUNTIME_DIR")
    if not base:
        base = os.environ.get("TMPDIR") or tempfile.gettempdir()
    return Path(base) / _APP


def default_socket_path() -> Path:
    return xdg_runtime_dir() / "daemon.sock"


def default_pid_path() -> Path:
    return xdg_data_dir() / "daemon.pid"


def default_log_path() -> Path:
    return xdg_data_dir() / "daemon.log"


def default_registry_path() -> Path:
    return xdg_data_dir() / "registry.json"


def session_dir(data_dir: Path, name: str) -> Path:
    return data_dir / "sessions" / name
