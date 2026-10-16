"""Record published values for plotting and inspection."""

from __future__ import annotations

from typing import Any, Iterable

from .flatten import PortRef


class Recorder:
    """Listener storing ``(t, value)`` samples per leaf output.

    Args:
        ports: Leaf outputs ``(path, port)`` to record; ``None`` records all.
    """

    def __init__(self, ports: Iterable[PortRef] | None = None) -> None:
        self.ports = set(ports) if ports is not None else None
        self.samples: dict[PortRef, list[tuple[float, Any]]] = {}

    def __call__(self, t: float, path: str, port: str, value: Any) -> None:
        key = (path, port)
        if self.ports is None or key in self.ports:
            self.samples.setdefault(key, []).append((t, value))

    def series(self, path: str, port: str) -> tuple[list[float], list[Any]]:
        """Return ``(times, values)`` recorded for ``path.port``."""
        data = self.samples.get((path, port), [])
        return [s[0] for s in data], [s[1] for s in data]
