"""Plugin exception taxonomy with exit-code mapping."""

from __future__ import annotations

from typing import Any


class CodexTeamError(Exception):
    code: str = "E_INTERNAL"
    exit_code: int = 1

    def __init__(self, msg: str = "", *, detail: dict[str, Any] | None = None) -> None:
        super().__init__(msg)
        self.detail: dict[str, Any] = detail or {}


class ConfigError(CodexTeamError):
    code = "E_CONFIG"
    exit_code = 2


class InvalidRequest(CodexTeamError):
    code = "E_INVALID"
    exit_code = 2


class DaemonNotRunning(CodexTeamError):
    code = "E_DAEMON_DOWN"
    exit_code = 4


class DaemonAlreadyRunning(CodexTeamError):
    code = "E_DAEMON_UP"
    exit_code = 4


class SessionNotFound(CodexTeamError):
    code = "E_NOT_FOUND"
    exit_code = 3


class SessionExists(CodexTeamError):
    code = "E_EXISTS"
    exit_code = 3


class SessionBusy(CodexTeamError):
    code = "E_BUSY"
    exit_code = 3


class SessionErrored(CodexTeamError):
    code = "E_ERRORED"
    exit_code = 3


class QueueFull(CodexTeamError):
    code = "E_QUEUE_FULL"
    exit_code = 3


class TransportError(CodexTeamError):
    code = "E_TRANSPORT"
    exit_code = 5


class TurnTimeout(CodexTeamError):
    code = "E_TIMEOUT"
    exit_code = 5


class CodexCliMissing(CodexTeamError):
    code = "E_NO_CODEX_BIN"
    exit_code = 4


def _all_subclasses(base: type[CodexTeamError]) -> list[type[CodexTeamError]]:
    direct = base.__subclasses__()
    out: list[type[CodexTeamError]] = []
    for cls in direct:
        out.append(cls)
        out.extend(_all_subclasses(cls))
    return out


_CODE_TO_CLASS: dict[str, type[CodexTeamError]] = {
    cls.code: cls for cls in _all_subclasses(CodexTeamError)
}


def error_to_wire(err: CodexTeamError) -> dict[str, Any]:
    return {"code": err.code, "msg": str(err), "detail": dict(err.detail)}


def wire_to_error(wire: dict[str, Any]) -> CodexTeamError:
    cls = _CODE_TO_CLASS.get(str(wire.get("code", "")), CodexTeamError)
    return cls(str(wire.get("msg", "")), detail=dict(wire.get("detail") or {}))
