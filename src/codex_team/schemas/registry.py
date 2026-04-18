from __future__ import annotations

from enum import Enum

from pydantic import BaseModel


class SessionStatus(str, Enum):
    idle = "idle"
    running = "running"
    errored = "errored"
    closed = "closed"
    compacting = "compacting"


class RegistryEntry(BaseModel):
    name: str
    thread_id: str
    cwd: str
    model: str
    model_provider: str | None = None
    sandbox: str
    approval_policy: str = "never"
    service_tier: str | None = None
    reasoning_effort: str | None = None
    personality: str | None = None
    profile: str | None = None
    created_at: str = ""
    last_turn_id: str | None = None
    last_turn_ended_at: str | None = None
    last_prompt_text: str | None = None
    status: SessionStatus = SessionStatus.idle
    app_server_pid: int | None = None
    queue_length: int = 0
    token_usage_input: int = 0
    error_message: str | None = None
