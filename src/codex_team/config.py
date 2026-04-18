"""TOML configuration and env-var overrides."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import Any, Literal, get_args, get_origin

from pydantic import BaseModel, Field

from codex_team.errors import CodexCliMissing, ConfigError
from codex_team.paths import default_socket_path, xdg_config_dir, xdg_data_dir

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib  # type: ignore[no-redef]


class DaemonCfg(BaseModel):
    socket_path: str = ""
    data_dir: str = ""
    log_level: Literal["debug", "info", "warn", "error"] = "info"
    codex_bin: str = ""
    codex_home: str = ""
    launch_args_override: list[str] = Field(default_factory=list)
    config_overrides: list[str] = Field(default_factory=list)


class DefaultsCfg(BaseModel):
    model: str = "gpt-5.4"
    model_provider: str = ""
    sandbox: str = "danger_full_access"
    approval_policy: str = "never"
    cwd: str = ""
    auto_resume_on_daemon_start: bool = True
    service_tier: str = ""
    reasoning_effort: str = ""
    personality: str = ""
    base_instructions: str = ""
    developer_instructions: str = ""
    profile: str = ""


class ProfileCfg(BaseModel):
    model: str = ""
    model_provider: str = ""
    sandbox: str = ""
    approval_policy: str = ""
    cwd: str = ""
    service_tier: str = ""
    reasoning_effort: str = ""
    personality: str = ""
    base_instructions: str = ""
    developer_instructions: str = ""
    ephemeral: bool = False


class DigestCfg(BaseModel):
    history_md_enabled: bool = True
    turns_jsonl_enabled: bool = True
    command_truncate_chars: int = 120
    agent_message_full: bool = True
    reasoning_capture: bool = False
    stderr_tail_lines_on_fail: int = 20
    max_files_listed: int = 8
    tool_args_truncate_chars: int = 80
    history_rotation_mb: int = 32


class CompactionCfg(BaseModel):
    threshold_tokens: int = 500_000
    mode: Literal["manual"] = "manual"
    progress_doc_template: str = ""


class MonitorCfg(BaseModel):
    events_max_buffer: int = 1000
    watchdog_interval_seconds: int = 1200
    watchdog_task_brief_file: str = ""
    watchdog_task_brief_head_lines: int = 30
    watchdog_stale_minutes: int = 30
    subscriber_queue_max: int = 200


class HeartbeatCfg(BaseModel):
    interval_seconds: int = 60
    turn_stuck_seconds: int = 600
    self_heal_once: bool = True
    health_timeout_seconds: int = 15
    health_check_concurrency: int = 8
    resume_timeout_seconds: int = 30
    self_heal_backoff_seconds: int = 30


class QueueCfg(BaseModel):
    max_per_session: int = 5
    overflow_policy: Literal["warn", "reject", "drop_oldest"] = "warn"


class Config(BaseModel):
    daemon: DaemonCfg = Field(default_factory=DaemonCfg)
    defaults: DefaultsCfg = Field(default_factory=DefaultsCfg)
    digest: DigestCfg = Field(default_factory=DigestCfg)
    compaction: CompactionCfg = Field(default_factory=CompactionCfg)
    monitor: MonitorCfg = Field(default_factory=MonitorCfg)
    heartbeat: HeartbeatCfg = Field(default_factory=HeartbeatCfg)
    queue: QueueCfg = Field(default_factory=QueueCfg)
    profiles: dict[str, ProfileCfg] = Field(default_factory=dict)


_BOOL_TRUE = {"1", "true", "yes", "on"}
_BOOL_FALSE = {"0", "false", "no", "off"}


def default_config_path() -> Path:
    return xdg_config_dir() / "config.toml"


def default_data_dir() -> Path:
    return xdg_data_dir()


def default_runtime_socket() -> Path:
    return default_socket_path()


def load_config(path: Path | None = None) -> Config:
    config_path = path or default_config_path()
    if not config_path.exists():
        cfg = Config()
    else:
        try:
            raw = tomllib.loads(config_path.read_text("utf-8"))
        except tomllib.TOMLDecodeError as exc:
            raise ConfigError(f"Invalid TOML in {config_path}: {exc}") from exc
        except OSError as exc:
            raise ConfigError(f"Unable to read {config_path}: {exc}") from exc
        try:
            cfg = Config.model_validate(raw)
        except Exception as exc:  # noqa: BLE001
            raise ConfigError(f"Config schema invalid: {exc}") from exc
    apply_env_overrides(cfg)
    return cfg


def _coerce(value: str, annotation: Any) -> object:
    origin = get_origin(annotation)
    if origin is Literal:
        literal_values = set(get_args(annotation))
        if value not in literal_values:
            raise ConfigError(f"Cannot coerce {value!r} to one of {sorted(literal_values)!r}")
        return value
    if annotation is bool:
        lowered = value.strip().lower()
        if lowered in _BOOL_TRUE:
            return True
        if lowered in _BOOL_FALSE:
            return False
        raise ConfigError(f"Cannot coerce {value!r} to bool")
    if annotation is int:
        return int(value)
    if annotation is float:
        return float(value)
    return value


def apply_env_overrides(cfg: Config) -> None:
    for section_name, section_model in cfg.__dict__.items():
        if not isinstance(section_model, BaseModel):
            continue
        for field_name, field_info in section_model.__class__.model_fields.items():
            env_key = f"CODEX_TEAM_{section_name.upper()}_{field_name.upper()}"
            if env_key not in os.environ:
                continue
            raw = os.environ[env_key]
            coerced = _coerce(raw, field_info.annotation)
            setattr(section_model, field_name, coerced)


def resolve_data_dir(cfg: Config) -> Path:
    return Path(cfg.daemon.data_dir) if cfg.daemon.data_dir else default_data_dir()


def resolve_socket_path(cfg: Config) -> Path:
    return Path(cfg.daemon.socket_path) if cfg.daemon.socket_path else default_runtime_socket()


def resolve_codex_bin(cfg: Config) -> str:
    configured = cfg.daemon.codex_bin.strip()
    if configured:
        return configured

    env_value = os.environ.get("CODEX_TEAM_CODEX_BIN", "").strip()
    if env_value:
        return env_value

    path_value = shutil.which("codex")
    if path_value:
        return path_value

    try:
        from codex_cli_bin import bundled_codex_path
    except ImportError:
        bundled = None
    else:
        bundled = bundled_codex_path()
        if bundled:
            return str(bundled)

    raise CodexCliMissing("unable to resolve codex binary")


def normalize_sandbox_mode(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    return normalized.replace("_", "-")


def normalize_approval_policy(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    return normalized.replace("_", "-")
