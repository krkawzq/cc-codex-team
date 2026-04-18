"""Async Codex SDK fakes for unit tests."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, AsyncIterator


@dataclass
class FakeNotification:
    method: str
    payload: Any


@dataclass
class FakeThreadItem:
    type: str
    data: dict = field(default_factory=dict)

    def __getattr__(self, key):
        return self.data.get(key)


class FakeTurnHandle:
    def __init__(self, events: list[FakeNotification], turn_id: str = "tr_1"):
        self.id = turn_id
        self._events = events
        self._interrupted = False

    async def interrupt(self):
        self._interrupted = True

    async def stream(self) -> AsyncIterator[FakeNotification]:
        for event in self._events:
            if self._interrupted:
                return
            await asyncio.sleep(0)
            yield event


class FakeThread:
    def __init__(self, thread_id: str = "thr_1"):
        self.id = thread_id
        self.queued_turns: list[list[FakeNotification]] = []

    async def turn(self, *_, **__):
        if not self.queued_turns:
            class CompletedTurn:
                id = "tr_x"
                status = "completed"
                error = None

            return FakeTurnHandle(
                [
                    FakeNotification("turn/started", {}),
                    FakeNotification("turn/completed", type("P", (), {"turn": CompletedTurn()})()),
                ]
            )
        return FakeTurnHandle(self.queued_turns.pop(0))

    async def compact(self):
        return {"ok": True}

    async def read(self, *_, **__):
        return type("R", (), {"thread": type("T", (), {"turns": []})()})()

    async def set_name(self, _):
        return None


class FakeAsyncCodex:
    def __init__(self, *, queued_turns: list[list[FakeNotification]] | None = None):
        self._queued = queued_turns or []
        self._thread: FakeThread | None = None
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()

    async def thread_start(self, **_kwargs):
        self._thread = FakeThread()
        self._thread.queued_turns = list(self._queued)
        return self._thread

    async def thread_resume(self, thread_id, **_kwargs):
        self._thread = FakeThread(thread_id)
        self._thread.queued_turns = list(self._queued)
        return self._thread

    async def close(self):
        self.closed = True
