import pytest

from codex_team.daemon.queue import OverflowPolicy, PendingSend, SendQueue
from codex_team.errors import QueueFull


def test_enqueue_and_pop():
    queue = SendQueue(max_size=3, policy=OverflowPolicy.warn)
    queue.enqueue(PendingSend(id="a", text="hi"))
    queue.enqueue(PendingSend(id="b", text="bye"))
    assert queue.pop().id == "a"
    assert queue.pop().id == "b"
    assert queue.pop() is None


def test_overflow_reject_raises():
    queue = SendQueue(max_size=2, policy=OverflowPolicy.reject)
    queue.enqueue(PendingSend(id="a", text=""))
    queue.enqueue(PendingSend(id="b", text=""))
    with pytest.raises(QueueFull):
        queue.enqueue(PendingSend(id="c", text=""))


def test_overflow_drop_oldest_drops_head():
    queue = SendQueue(max_size=2, policy=OverflowPolicy.drop_oldest)
    queue.enqueue(PendingSend(id="a", text=""))
    queue.enqueue(PendingSend(id="b", text=""))
    queue.enqueue(PendingSend(id="c", text=""))
    assert [item.id for item in queue.snapshot()] == ["b", "c"]


def test_overflow_warn_allows_overflow_and_returns_warning():
    queue = SendQueue(max_size=2, policy=OverflowPolicy.warn)
    queue.enqueue(PendingSend(id="a", text=""))
    queue.enqueue(PendingSend(id="b", text=""))
    warned = queue.enqueue(PendingSend(id="c", text=""))
    assert warned is True
    assert len(queue.snapshot()) == 3


def test_clear():
    queue = SendQueue(max_size=5, policy=OverflowPolicy.warn)
    queue.enqueue(PendingSend(id="a", text=""))
    queue.clear()
    assert queue.pop() is None


def test_drop_oldest_one():
    queue = SendQueue(max_size=5, policy=OverflowPolicy.warn)
    queue.enqueue(PendingSend(id="a", text=""))
    queue.enqueue(PendingSend(id="b", text=""))
    dropped = queue.drop_oldest()
    assert dropped.id == "a"
    assert queue.pop().id == "b"
