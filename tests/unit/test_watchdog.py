import asyncio
from pathlib import Path

import pytest

from codex_team.config import Config
from codex_team.daemon.event_bus import EventBus
from codex_team.daemon.registry import RegistryStore
from codex_team.daemon.watchdog import WatchdogTimer
from codex_team.schemas.registry import RegistryEntry


@pytest.mark.asyncio
async def test_watchdog_emits_block_with_brief(tmp_path: Path):
    brief = tmp_path / "brief.md"
    brief.write_text("line1\nline2\nline3\n", "utf-8")
    cfg = Config()
    cfg.monitor.watchdog_interval_seconds = 1
    cfg.monitor.watchdog_task_brief_file = str(brief)
    cfg.monitor.watchdog_task_brief_head_lines = 2

    registry = RegistryStore(tmp_path / "registry.json")
    registry.create(RegistryEntry(name="A", thread_id="t", cwd=".", model="m", sandbox="s"))
    bus = EventBus()

    timer = WatchdogTimer(cfg=cfg, registry=registry, event_bus=bus)
    sub = await bus.subscribe("watchdog")
    await timer.tick_once()
    event = await asyncio.wait_for(sub.get(), 1)
    assert "task_brief" in event.payload
    assert "line1" in event.payload["task_brief"]
    assert "line3" not in event.payload["task_brief"]
    assert event.payload["sessions"][0]["name"] == "A"
