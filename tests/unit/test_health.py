import asyncio
from pathlib import Path

import pytest

from codex_team.config import Config
from codex_team.daemon.event_bus import EventBus
from codex_team.daemon.health import HealthMonitor
from codex_team.daemon.registry import RegistryStore
from codex_team.schemas.registry import RegistryEntry, SessionStatus


@pytest.mark.asyncio
async def test_health_reports_unreachable(tmp_path: Path):
    cfg = Config()
    cfg.heartbeat.interval_seconds = 1
    registry = RegistryStore(tmp_path / "registry.json")
    registry.create(RegistryEntry(name="A", thread_id="thr", cwd=".", model="m", sandbox="s"))
    bus = EventBus()
    monitor = HealthMonitor(cfg=cfg, registry=registry, sessions={}, event_bus=bus, factory=None)
    sub = await bus.subscribe("events")
    await monitor.tick_once()
    event = await asyncio.wait_for(sub.get(), timeout=2)
    assert event.payload["kind"] == "session-down"
    assert event.payload["session"] == "A"


@pytest.mark.asyncio
async def test_health_self_heals_once(tmp_path: Path):
    cfg = Config()
    cfg.heartbeat.self_heal_once = True
    registry = RegistryStore(tmp_path / "registry.json")
    registry.create(
        RegistryEntry(name="A", thread_id="thr", cwd=".", model="m", sandbox="s", status=SessionStatus.errored)
    )
    bus = EventBus()

    class FakeFactory:
        def __init__(self):
            self.called = 0

        async def resume(self, name):
            self.called += 1
            return "resumed-session"

    factory = FakeFactory()
    monitor = HealthMonitor(cfg=cfg, registry=registry, sessions={}, event_bus=bus, factory=factory)
    sub = await bus.subscribe("events")
    await monitor.tick_once()
    event = await asyncio.wait_for(sub.get(), 2)
    assert event.payload["kind"] in {"auto-heal", "session-down"}
    assert factory.called == 1
