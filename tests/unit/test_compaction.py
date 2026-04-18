import asyncio
from pathlib import Path

import pytest

from codex_team.config import Config
from codex_team.daemon.compaction import CompactionMonitor
from codex_team.daemon.event_bus import EventBus
from codex_team.daemon.registry import RegistryStore
from codex_team.schemas.registry import RegistryEntry


@pytest.mark.asyncio
async def test_suggest_emitted_on_cross(tmp_path: Path):
    cfg = Config()
    cfg.compaction.threshold_tokens = 100
    registry = RegistryStore(tmp_path / "registry.json")
    registry.create(RegistryEntry(name="A", thread_id="t", cwd=".", model="m", sandbox="s"))
    bus = EventBus()
    monitor = CompactionMonitor(cfg=cfg, registry=registry, event_bus=bus)
    sub = await bus.subscribe("events")
    registry.update("A", token_usage_input=50)
    await monitor.observe_usage("A", 50)
    assert sub.empty()
    registry.update("A", token_usage_input=150)
    await monitor.observe_usage("A", 150)
    event = await asyncio.wait_for(sub.get(), 1)
    assert event.payload["kind"] == "compact-suggest"
    assert event.payload["tokens"] == 150


@pytest.mark.asyncio
async def test_suggest_only_fires_once(tmp_path: Path):
    cfg = Config()
    cfg.compaction.threshold_tokens = 100
    registry = RegistryStore(tmp_path / "registry.json")
    registry.create(RegistryEntry(name="A", thread_id="t", cwd=".", model="m", sandbox="s"))
    bus = EventBus()
    monitor = CompactionMonitor(cfg=cfg, registry=registry, event_bus=bus)
    sub = await bus.subscribe("events")
    await monitor.observe_usage("A", 120)
    await monitor.observe_usage("A", 180)
    event = await asyncio.wait_for(sub.get(), 1)
    await asyncio.sleep(0)
    assert sub.empty()
    assert event.payload["kind"] == "compact-suggest"
