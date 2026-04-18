"""Wire protocol: newline-delimited JSON."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from codex_team.errors import InvalidRequest


class Request(BaseModel):
    id: str
    cmd: str
    params: dict[str, Any] = Field(default_factory=dict)


class Response(BaseModel):
    id: str
    ok: bool
    data: dict[str, Any] | None = None
    error: dict[str, Any] | None = None


class StreamEvent(BaseModel):
    kind: Literal["event"] = "event"
    stream: Literal["events", "watchdog"]
    seq: int
    payload: dict[str, Any]


def encode(msg: Request | Response | StreamEvent) -> str:
    return msg.model_dump_json(exclude_none=True) + "\n"


def _validate(model: type[BaseModel], data: dict[str, Any]) -> Any:
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise InvalidRequest(f"Schema error: {exc}") from exc


def decode_message(line: str) -> Request | Response | StreamEvent:
    payload = line.rstrip("\n")
    if not payload:
        raise InvalidRequest("Empty line")
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise InvalidRequest(f"Bad JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise InvalidRequest("Message is not an object")
    if "cmd" in data and "id" in data:
        return _validate(Request, data)
    if "ok" in data and "id" in data:
        return _validate(Response, data)
    if data.get("kind") == "event":
        return _validate(StreamEvent, data)
    raise InvalidRequest("Unknown message shape")
