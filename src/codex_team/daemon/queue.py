from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from enum import Enum

from codex_team.errors import QueueFull


class OverflowPolicy(str, Enum):
    warn = "warn"
    reject = "reject"
    drop_oldest = "drop_oldest"


@dataclass
class PendingSend:
    id: str
    text: str
    wait_future: object | None = None
    overrides: dict | None = None


class SendQueue:
    def __init__(self, *, max_size: int, policy: OverflowPolicy) -> None:
        self._items: deque[PendingSend] = deque()
        self._max_size = max_size
        self._policy = policy

    def enqueue(self, item: PendingSend) -> bool:
        if len(self._items) < self._max_size:
            self._items.append(item)
            return False
        if self._policy == OverflowPolicy.reject:
            raise QueueFull(f"queue full (max={self._max_size})", detail={"size": self._max_size})
        if self._policy == OverflowPolicy.drop_oldest:
            self._items.popleft()
            self._items.append(item)
            return False
        self._items.append(item)
        return True

    def pop(self) -> PendingSend | None:
        return self._items.popleft() if self._items else None

    def snapshot(self) -> list[PendingSend]:
        return list(self._items)

    def clear(self) -> None:
        self._items.clear()

    def drop_oldest(self) -> PendingSend | None:
        return self._items.popleft() if self._items else None

    def __len__(self) -> int:
        return len(self._items)
