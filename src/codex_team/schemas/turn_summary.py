from __future__ import annotations

from enum import Enum

from pydantic import BaseModel


class DigestLineKind(str, Enum):
    command = "command"
    file_change = "file_change"
    agent_message = "agent_message"
    tool_call = "tool_call"
    web_search = "web_search"
    collab_agent = "collab_agent"


class DigestLine(BaseModel):
    kind: DigestLineKind
    text: str
    path: str | None = None
    lines_added: int | None = None
    lines_removed: int | None = None
    exit_code: int | None = None
    duration_ms: int | None = None
    stderr_tail: str | None = None
    tool_name: str | None = None


class TurnTier(str, Enum):
    trivial = "trivial"
    normal = "normal"
    attn = "attn"


class TurnSummary(BaseModel):
    session: str
    turn_id: str
    elapsed_ms: int
    status: str
    tier: TurnTier
    final_message: str | None
    files_added: int
    files_removed: int
    lines: list[DigestLine]
    usage_last_tokens: int | None = None
    usage_total_tokens: int | None = None
    error_message: str | None = None
    completed_at: str | None = None
