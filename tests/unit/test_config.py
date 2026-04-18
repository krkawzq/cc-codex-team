import textwrap
from pathlib import Path

import pytest

from codex_team.config import (
    Config,
    apply_env_overrides,
    load_config,
    normalize_approval_policy,
    normalize_sandbox_mode,
)
from codex_team.errors import ConfigError


def test_config_defaults():
    cfg = Config()
    assert cfg.daemon.log_level == "info"
    assert cfg.defaults.model == "gpt-5.4"
    assert cfg.defaults.sandbox == "danger_full_access"
    assert cfg.digest.command_truncate_chars == 120
    assert cfg.compaction.threshold_tokens == 500_000
    assert cfg.monitor.watchdog_interval_seconds == 1200
    assert cfg.heartbeat.interval_seconds == 60
    assert cfg.queue.max_per_session == 5


def test_load_config_from_toml(tmp_path: Path):
    path = tmp_path / "config.toml"
    path.write_text(
        textwrap.dedent(
            """
            [defaults]
            model = "gpt-5.4-mini"

            [compaction]
            threshold_tokens = 750000
            """
        ).strip()
    )
    cfg = load_config(path)
    assert cfg.defaults.model == "gpt-5.4-mini"
    assert cfg.compaction.threshold_tokens == 750_000
    assert cfg.defaults.sandbox == "danger_full_access"


def test_env_overrides_scalars(monkeypatch):
    cfg = Config()
    monkeypatch.setenv("CODEX_TEAM_COMPACTION_THRESHOLD_TOKENS", "900000")
    monkeypatch.setenv("CODEX_TEAM_DEFAULTS_MODEL", "gpt-5.4-preview")
    apply_env_overrides(cfg)
    assert cfg.compaction.threshold_tokens == 900_000
    assert cfg.defaults.model == "gpt-5.4-preview"


def test_env_override_bool(monkeypatch):
    cfg = Config()
    monkeypatch.setenv("CODEX_TEAM_HEARTBEAT_SELF_HEAL_ONCE", "false")
    apply_env_overrides(cfg)
    assert cfg.heartbeat.self_heal_once is False


def test_load_missing_file_is_ok(tmp_path: Path):
    cfg = load_config(tmp_path / "missing.toml")
    assert isinstance(cfg, Config)


def test_load_bad_toml_raises(tmp_path: Path):
    path = tmp_path / "config.toml"
    path.write_text("this is not = valid toml [[[")
    with pytest.raises(ConfigError):
        load_config(path)


def test_wire_value_normalization_helpers():
    assert normalize_sandbox_mode("danger_full_access") == "danger-full-access"
    assert normalize_approval_policy("on_request") == "on-request"


def test_load_profile_configuration(tmp_path: Path):
    path = tmp_path / "config.toml"
    path.write_text(
        textwrap.dedent(
            """
            [profiles.reviewer]
            model = "gpt-5.4-mini"
            approval_policy = "never"
            reasoning_effort = "high"
            """
        ).strip()
    )
    cfg = load_config(path)
    assert cfg.profiles["reviewer"].model == "gpt-5.4-mini"
    assert cfg.profiles["reviewer"].reasoning_effort == "high"
