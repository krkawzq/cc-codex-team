from pathlib import Path

from codex_team.paths import xdg_config_dir, xdg_data_dir, xdg_runtime_dir


def test_xdg_config_dir_respects_env(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert xdg_config_dir() == tmp_path / "codex-team"


def test_xdg_data_dir_respects_env(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert xdg_data_dir() == tmp_path / "codex-team"


def test_xdg_config_dir_default(monkeypatch):
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.setenv("HOME", "/home/u")
    assert xdg_config_dir() == Path("/home/u/.config/codex-team")


def test_xdg_runtime_dir_falls_back_to_tmp(monkeypatch, tmp_path):
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    result = xdg_runtime_dir()
    assert str(tmp_path) in str(result)
    assert result.name == "codex-team"
