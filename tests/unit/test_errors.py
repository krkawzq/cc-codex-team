from codex_team.errors import (
    CodexTeamError,
    CodexCliMissing,
    ConfigError,
    DaemonNotRunning,
    QueueFull,
    SessionExists,
    SessionNotFound,
    TurnTimeout,
    error_to_wire,
    wire_to_error,
)


def test_subclasses_have_unique_codes():
    classes = [
        ConfigError,
        DaemonNotRunning,
        SessionNotFound,
        SessionExists,
        QueueFull,
        TurnTimeout,
        CodexCliMissing,
    ]
    codes = [cls.code for cls in classes]
    assert len(set(codes)) == len(codes)


def test_all_subclasses_set_exit_code_in_1_to_5():
    for cls in CodexTeamError.__subclasses__():
        assert 1 <= cls.exit_code <= 5


def test_error_to_wire_shape():
    wire = error_to_wire(SessionNotFound("session X not known"))
    assert wire == {"code": "E_NOT_FOUND", "msg": "session X not known", "detail": {}}


def test_error_to_wire_with_detail():
    error = QueueFull("queue full")
    error.detail = {"name": "L-kernels", "size": 5}
    wire = error_to_wire(error)
    assert wire["detail"] == {"name": "L-kernels", "size": 5}


def test_wire_to_error_roundtrip():
    error = wire_to_error({"code": "E_EXISTS", "msg": "already here", "detail": {"name": "x"}})
    assert isinstance(error, SessionExists)
    assert error.args[0] == "already here"
    assert error.detail == {"name": "x"}


def test_wire_to_error_unknown_code_falls_back_to_base():
    error = wire_to_error({"code": "E_UFO", "msg": "?", "detail": {}})
    assert type(error) is CodexTeamError
