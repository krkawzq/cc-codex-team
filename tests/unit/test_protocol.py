import json

import pytest

from codex_team.errors import InvalidRequest
from codex_team.protocol import Request, Response, StreamEvent, decode_message, encode


def test_request_roundtrip():
    request = Request(id="r1", cmd="session.create", params={"name": "A"})
    message = decode_message(encode(request))
    assert isinstance(message, Request)
    assert message.cmd == "session.create"
    assert message.params == {"name": "A"}


def test_response_ok_roundtrip():
    response = Response(id="r1", ok=True, data={"x": 1})
    message = decode_message(encode(response))
    assert isinstance(message, Response)
    assert message.ok is True
    assert message.data == {"x": 1}


def test_response_error_roundtrip():
    response = Response(id="r1", ok=False, error={"code": "E_NOT_FOUND", "msg": "no", "detail": {}})
    message = decode_message(encode(response))
    assert isinstance(message, Response)
    assert message.ok is False
    assert message.error["code"] == "E_NOT_FOUND"


def test_stream_event_roundtrip():
    event = StreamEvent(stream="events", seq=42, payload={"kind": "turn-done"})
    message = decode_message(encode(event))
    assert isinstance(message, StreamEvent)
    assert message.seq == 42


def test_decode_invalid_json_raises():
    with pytest.raises(InvalidRequest):
        decode_message("{not json\n")


def test_decode_unknown_shape_raises():
    with pytest.raises(InvalidRequest):
        decode_message(json.dumps({"hello": "world"}) + "\n")
