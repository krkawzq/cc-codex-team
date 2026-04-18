from __future__ import annotations

import datetime
from pathlib import Path

from codex_team.config import Config
from codex_team.daemon.event_bus import EventBus
from codex_team.daemon.registry import RegistryStore


class WatchdogTimer:
    def __init__(self, *, cfg: Config, registry: RegistryStore, event_bus: EventBus):
        self._cfg = cfg
        self._registry = registry
        self._event_bus = event_bus

    def _read_brief(self) -> str:
        brief_file = self._cfg.monitor.watchdog_task_brief_file
        if not brief_file:
            return ""
        path = Path(brief_file)
        if not path.exists():
            return ""
        limit = self._cfg.monitor.watchdog_task_brief_head_lines
        return "\n".join(path.read_text("utf-8").splitlines()[:limit])

    async def tick_once(self) -> None:
        now = datetime.datetime.now(datetime.timezone.utc)
        sessions = []
        stale_minutes = self._cfg.monitor.watchdog_stale_minutes
        for entry in self._registry.list():
            advisories: list[str] = []
            if entry.token_usage_input >= self._cfg.compaction.threshold_tokens:
                advisories.append("crossed compaction threshold")
            if entry.last_turn_ended_at:
                try:
                    last = datetime.datetime.fromisoformat(entry.last_turn_ended_at)
                except ValueError:
                    last = None
                if last is not None:
                    idle_minutes = (now - last).total_seconds() / 60
                    if idle_minutes > stale_minutes:
                        advisories.append(f"idle > {stale_minutes}m")
            sessions.append(
                {
                    "name": entry.name,
                    "status": entry.status.value,
                    "thread_id_short": entry.thread_id[:8],
                    "tokens": entry.token_usage_input,
                    "queue": entry.queue_length,
                    "advisories": advisories,
                }
            )
        self._event_bus.publish(
            "watchdog",
            {
                "kind": "watchdog-tick",
                "at": now.isoformat(),
                "task_brief": self._read_brief(),
                "sessions": sessions,
            },
        )
