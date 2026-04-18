import asyncio

import pytest

from codex_team.daemon.event_bus import EventBus


@pytest.mark.asyncio
async def test_publish_and_subscribe_receives():
    bus = EventBus(max_buffer=100)
    sub = await bus.subscribe("events")
    bus.publish("events", {"kind": "hello"})
    event = await asyncio.wait_for(sub.get(), timeout=1)
    assert event.seq == 1
    assert event.payload == {"kind": "hello"}
    await bus.unsubscribe("events", sub)


@pytest.mark.asyncio
async def test_seq_monotonic():
    bus = EventBus(max_buffer=100)
    bus.publish("events", {"x": 1})
    bus.publish("events", {"x": 2})
    sub = await bus.subscribe("events", since_seq=0)
    seqs = [(await asyncio.wait_for(sub.get(), 1)).seq for _ in range(2)]
    assert seqs == [1, 2]


@pytest.mark.asyncio
async def test_since_seq_skips_earlier():
    bus = EventBus(max_buffer=100)
    bus.publish("events", {"x": 1})
    bus.publish("events", {"x": 2})
    bus.publish("events", {"x": 3})
    sub = await bus.subscribe("events", since_seq=2)
    event = await asyncio.wait_for(sub.get(), 1)
    assert event.seq == 3


@pytest.mark.asyncio
async def test_separate_streams_independent():
    bus = EventBus(max_buffer=100)
    events = await bus.subscribe("events")
    watchdog = await bus.subscribe("watchdog")
    bus.publish("events", {"a": 1})
    bus.publish("watchdog", {"b": 2})
    assert (await asyncio.wait_for(events.get(), 1)).payload == {"a": 1}
    assert (await asyncio.wait_for(watchdog.get(), 1)).payload == {"b": 2}


@pytest.mark.asyncio
async def test_subscriber_queue_drops_oldest_when_full():
    bus = EventBus(max_buffer=10, subscriber_queue_max=2)
    sub = await bus.subscribe("events")
    bus.publish("events", {"seq": 1})
    bus.publish("events", {"seq": 2})
    bus.publish("events", {"seq": 3})
    first = await asyncio.wait_for(sub.get(), 1)
    second = await asyncio.wait_for(sub.get(), 1)
    assert [first.payload["seq"], second.payload["seq"]] == [2, 3]
