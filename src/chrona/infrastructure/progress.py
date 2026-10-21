"""Observe instance-local pipeline progress without patching global library state."""

from contextlib import contextmanager
from time import perf_counter


class ObservedProgress:
    def __init__(self, bar, total, callback):
        self.bar, self.total, self.callback = bar, total, callback
        self.completed = 0
        self.started = perf_counter()

    def __enter__(self):
        self.bar.__enter__()
        self.callback("start", 0, self.total, 0)
        return self

    def update(self, n=1):
        self.bar.update(n)
        self.completed += n
        self.callback(
            "step", self.completed, self.total, perf_counter() - self.started
        )

    def __exit__(self, kind, value, traceback):
        try:
            return self.bar.__exit__(kind, value, traceback)
        finally:
            if kind is None:
                self.callback(
                    "end",
                    self.completed,
                    self.total,
                    perf_counter() - self.started,
                )

    def __getattr__(self, name):
        return getattr(self.bar, name)


@contextmanager
def observe_steps(block, callback):
    """Wrap only this pipeline's progress-bar factories; always restore on error."""
    restored = []
    visited = set()

    def visit(current):
        if id(current) in visited:
            return
        visited.add(id(current))
        original = getattr(current, "progress_bar", None)
        if callable(original):
            previous = current.__dict__.get("progress_bar")
            had_override = "progress_bar" in current.__dict__

            def factory(*args, _original=original, **kwargs):
                bar = _original(*args, **kwargs)
                return ObservedProgress(
                    bar,
                    kwargs.get("total", getattr(bar, "total", None)),
                    callback,
                )

            current.progress_bar = factory
            restored.append((current, had_override, previous))
        for child in getattr(current, "sub_blocks", {}).values():
            visit(child)

    try:
        visit(block)
        yield
    finally:
        for current, had_override, previous in reversed(restored):
            if had_override:
                current.progress_bar = previous
            else:
                del current.progress_bar
