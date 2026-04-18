from __future__ import annotations

from codex_team.config import Config
from codex_team.daemon.event_bus import EventBus
from codex_team.daemon.registry import RegistryStore


class CompactionMonitor:
    def __init__(self, *, cfg: Config, registry: RegistryStore, event_bus: EventBus):
        self._cfg = cfg
        self._registry = registry
        self._event_bus = event_bus
        self._suggested: set[str] = set()

    async def observe_usage(self, name: str, tokens: int) -> None:
        if tokens < self._cfg.compaction.threshold_tokens:
            return
        if name in self._suggested:
            return
        self._suggested.add(name)
        self._event_bus.publish(
            "events",
            {
                "kind": "compact-suggest",
                "session": name,
                "tokens": tokens,
                "threshold": self._cfg.compaction.threshold_tokens,
            },
        )

    def clear(self, name: str) -> None:
        self._suggested.discard(name)
