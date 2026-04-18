from __future__ import annotations

import asyncio
import time

from codex_team.config import Config
from codex_team.daemon.event_bus import EventBus
from codex_team.daemon.registry import RegistryStore
from codex_team.schemas.registry import SessionStatus


class HealthMonitor:
    def __init__(
        self,
        *,
        cfg: Config,
        registry: RegistryStore,
        sessions: dict,
        event_bus: EventBus,
        factory,
    ) -> None:
        self._cfg = cfg
        self._registry = registry
        self._sessions = sessions
        self._event_bus = event_bus
        self._factory = factory
        self._healed_at: dict[str, float] = {}

    async def tick_once(self) -> None:
        semaphore = asyncio.Semaphore(max(1, self._cfg.heartbeat.health_check_concurrency))

        async def check_entry(entry) -> None:
            if entry.status == SessionStatus.closed:
                return
            session = self._sessions.get(entry.name)
            if session is None:
                await self._on_down(entry.name)
                return
            try:
                async with semaphore:
                    if not session.is_transport_alive():
                        raise RuntimeError("transport is not alive")
                    await asyncio.wait_for(
                        session.health_check(),
                        timeout=self._cfg.heartbeat.health_timeout_seconds,
                    )
            except Exception as exc:  # noqa: BLE001
                self._registry.update(entry.name, status=SessionStatus.errored, error_message=str(exc))
                await self._on_down(entry.name, session=session)

        await asyncio.gather(*(check_entry(entry) for entry in self._registry.list()))

    async def _on_down(self, name: str, *, session=None) -> None:
        entry = self._registry.get(name)
        last_healed_at = self._healed_at.get(name)
        can_attempt_heal = (
            self._cfg.heartbeat.self_heal_once
            and self._factory is not None
            and (
                last_healed_at is None
                or time.monotonic() - last_healed_at >= self._cfg.heartbeat.self_heal_backoff_seconds
            )
        )
        if can_attempt_heal:
            self._healed_at[name] = time.monotonic()
            try:
                session = await asyncio.wait_for(
                    self._factory.resume(name),
                    timeout=self._cfg.heartbeat.resume_timeout_seconds,
                )
            except Exception as exc:  # noqa: BLE001
                self._registry.update(name, status=SessionStatus.errored, error_message=str(exc))
            else:
                self._sessions[name] = session
                self._registry.update(name, status=SessionStatus.idle, error_message=None)
                self._event_bus.publish("events", {"kind": "auto-heal", "session": name})
                return
        self._event_bus.publish(
            "events",
            {
                "kind": "session-down",
                "session": name,
                "last_error": entry.error_message or "",
                "stderr_tail": session.stderr_tail(limit=20) if session is not None else "",
            },
        )
