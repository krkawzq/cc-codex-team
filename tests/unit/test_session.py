import asyncio
from pathlib import Path

import pytest

from codex_team.config import Config, ProfileCfg
from codex_team.daemon.event_bus import EventBus
from codex_team.daemon.registry import RegistryStore
from codex_team.daemon.session import SessionFactory
from codex_team.schemas.registry import SessionStatus
from tests.fakes import FakeAsyncCodex, FakeNotification, FakeThreadItem


def _file_change_turn(path="x.py", added=5, removed=1):
    class CompletedTurn:
        id = "tr_1"
        status = "completed"
        error = None

    message_item = FakeThreadItem("agentMessage", {"text": "done", "phase": "final_answer"})
    file_change_item = FakeThreadItem(
        "fileChange",
        {"changes": [type("C", (), {"path": path, "lines_added": added, "lines_removed": removed})]},
    )
    return [
        FakeNotification("turn/started", type("S", (), {"turn": type("T2", (), {"id": "tr_1"})(), "threadId": "thr_1"})()),
        FakeNotification("item/completed", type("IC", (), {"item": file_change_item, "turn_id": "tr_1"})()),
        FakeNotification("item/completed", type("IC", (), {"item": message_item, "turn_id": "tr_1"})()),
        FakeNotification("turn/completed", type("TC", (), {"turn": CompletedTurn(), "threadId": "thr_1"})()),
    ]


@pytest.mark.asyncio
async def test_session_send_produces_turn_done_event(tmp_path: Path):
    cfg = Config()
    cfg.daemon.data_dir = str(tmp_path)
    bus = EventBus()
    registry = RegistryStore(tmp_path / "registry.json")
    factory = SessionFactory(
        cfg,
        registry,
        bus,
        codex_factory=lambda **_: FakeAsyncCodex(queued_turns=[_file_change_turn()]),
    )
    session = await factory.create("A", cwd=str(tmp_path))

    sub = await bus.subscribe("events")
    await session.send("do a thing")
    event = await asyncio.wait_for(sub.get(), timeout=2)
    assert event.payload["kind"] in {"turn-done", "turn-attn"}
    assert event.payload["session"] == "A"
    await session.close()


@pytest.mark.asyncio
async def test_session_writes_history_and_jsonl(tmp_path: Path):
    cfg = Config()
    cfg.daemon.data_dir = str(tmp_path)
    bus = EventBus()
    registry = RegistryStore(tmp_path / "registry.json")
    factory = SessionFactory(
        cfg,
        registry,
        bus,
        codex_factory=lambda **_: FakeAsyncCodex(queued_turns=[_file_change_turn()]),
    )
    session = await factory.create("A", cwd=str(tmp_path))
    await session.send("do a thing", wait=True)
    await session.close()

    history = (tmp_path / "sessions" / "A" / "history.md").read_text("utf-8")
    turns = (tmp_path / "sessions" / "A" / "turns.jsonl").read_text("utf-8")
    assert "## Turn tr_1" in history
    assert '"turn_id":"tr_1"' in turns


@pytest.mark.asyncio
async def test_session_status_transitions(tmp_path: Path):
    cfg = Config()
    cfg.daemon.data_dir = str(tmp_path)
    bus = EventBus()
    registry = RegistryStore(tmp_path / "registry.json")
    factory = SessionFactory(
        cfg,
        registry,
        bus,
        codex_factory=lambda **_: FakeAsyncCodex(queued_turns=[_file_change_turn()]),
    )
    session = await factory.create("A", cwd=str(tmp_path))
    assert registry.get("A").status == SessionStatus.idle
    await session.send("x", wait=True)
    assert registry.get("A").status == SessionStatus.idle
    await session.close()
    assert registry.get("A").status == SessionStatus.closed


@pytest.mark.asyncio
async def test_session_failed_turn_sets_registry_errored(tmp_path: Path):
    cfg = Config()
    cfg.daemon.data_dir = str(tmp_path)
    bus = EventBus()
    registry = RegistryStore(tmp_path / "registry.json")

    class FailedTurn:
        id = "tr_fail"
        status = "failed"
        error = type("E", (), {"message": "boom"})()

    failed_events = [
        FakeNotification("turn/started", type("S", (), {"turn": type("T2", (), {"id": "tr_fail"})(), "threadId": "thr_1"})()),
        FakeNotification("turn/completed", type("TC", (), {"turn": FailedTurn(), "threadId": "thr_1"})()),
    ]
    factory = SessionFactory(
        cfg,
        registry,
        bus,
        codex_factory=lambda **_: FakeAsyncCodex(queued_turns=[failed_events]),
    )
    session = await factory.create("A", cwd=str(tmp_path))
    await session.send("fail", wait=True)
    entry = registry.get("A")
    assert entry.status == SessionStatus.errored
    assert entry.error_message == "boom"


@pytest.mark.asyncio
async def test_profile_applied_to_session_create(tmp_path: Path):
    cfg = Config()
    cfg.daemon.data_dir = str(tmp_path)
    cfg.profiles["reviewer"] = ProfileCfg(model="gpt-5.4-mini", reasoning_effort="high")
    bus = EventBus()
    registry = RegistryStore(tmp_path / "registry.json")
    factory = SessionFactory(cfg, registry, bus, codex_factory=lambda **_: FakeAsyncCodex())
    await factory.create("A", cwd=str(tmp_path), profile="reviewer")
    entry = registry.get("A")
    assert entry.profile == "reviewer"
    assert entry.model == "gpt-5.4-mini"
    assert entry.reasoning_effort == "high"
