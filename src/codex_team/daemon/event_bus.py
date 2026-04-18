from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
from typing import Literal

StreamName = Literal["events", "watchdog"]


@dataclass
class BusEvent:
    seq: int
    stream: StreamName
    payload: dict


class EventBus:
    def __init__(self, *, max_buffer: int = 1000, subscriber_queue_max: int = 200) -> None:
        self._buffers: dict[str, deque[BusEvent]] = {}
        self._seqs: dict[str, int] = {}
        self._subs: dict[str, list[asyncio.Queue[BusEvent]]] = {}
        self._max_buffer = max_buffer
        self._subscriber_queue_max = subscriber_queue_max

    def publish(self, stream: StreamName, payload: dict) -> BusEvent:
        seq = self._seqs.get(stream, 0) + 1
        self._seqs[stream] = seq
        event = BusEvent(seq=seq, stream=stream, payload=payload)
        buffer = self._buffers.setdefault(stream, deque(maxlen=self._max_buffer))
        buffer.append(event)
        for queue in self._subs.get(stream, []):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(event)
        return event

    async def subscribe(self, stream: StreamName, *, since_seq: int = 0) -> asyncio.Queue[BusEvent]:
        queue: asyncio.Queue[BusEvent] = asyncio.Queue(maxsize=self._subscriber_queue_max)
        for event in self._buffers.get(stream, ()):
            if event.seq > since_seq:
                if queue.full():
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                queue.put_nowait(event)
        self._subs.setdefault(stream, []).append(queue)
        return queue

    async def unsubscribe(self, stream: StreamName, queue: asyncio.Queue[BusEvent]) -> None:
        subscribers = self._subs.get(stream, [])
        if queue in subscribers:
            subscribers.remove(queue)

    def last_seq(self, stream: StreamName) -> int:
        return self._seqs.get(stream, 0)
