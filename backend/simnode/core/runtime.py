"""Objects handed to node callbacks: ``inp``, ``out``, ``p`` and ``state``."""

from __future__ import annotations

from typing import Any, Mapping


class Inputs:
    """Read-only view of the latest value on each input port.

    Access values as ``inp.name`` or ``inp["name"]``. ``inp.fresh(name)``
    tells whether a new message arrived since the node last fired, and
    ``inp.received(name)`` whether any message ever arrived.
    """

    __slots__ = ("_values", "_fresh", "_received")

    def __init__(self, values: Mapping[str, Any], fresh: set[str], received: set[str]) -> None:
        self._values = values
        self._fresh = fresh
        self._received = received

    def __getattr__(self, name: str) -> Any:
        try:
            return self._values[name]
        except KeyError:
            raise AttributeError(f"no input port named {name!r}") from None

    def __getitem__(self, name: str) -> Any:
        return self._values[name]

    def fresh(self, name: str) -> bool:
        """Return True if ``name`` got a message since the previous call."""
        return name in self._fresh

    def received(self, name: str) -> bool:
        """Return True if ``name`` has ever received a message."""
        return name in self._received


class Outputs:
    """Write-only collector: assigning ``out.name = v`` publishes ``v``.

    Only ports assigned during a call are published, in assignment order.
    """

    __slots__ = ("_allowed", "_published")

    def __init__(self, allowed: frozenset[str]) -> None:
        object.__setattr__(self, "_allowed", allowed)
        object.__setattr__(self, "_published", {})

    def __setattr__(self, name: str, value: Any) -> None:
        if name not in self._allowed:
            raise AttributeError(f"no output port named {name!r}")
        self._published[name] = value

    __setitem__ = __setattr__

    def __getattr__(self, name: str) -> Any:
        try:
            return self._published[name]
        except KeyError:
            raise AttributeError(f"output {name!r} not assigned in this call") from None


class Params:
    """Read-only node parameters, as ``p.name`` or ``p["name"]``."""

    __slots__ = ("_values",)

    def __init__(self, values: Mapping[str, Any]) -> None:
        object.__setattr__(self, "_values", dict(values))

    def __getattr__(self, name: str) -> Any:
        try:
            return self._values[name]
        except KeyError:
            raise AttributeError(f"no parameter named {name!r}") from None

    def __getitem__(self, name: str) -> Any:
        return self._values[name]

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("parameters are read-only inside callbacks")

    def get(self, name: str, default: Any = None) -> Any:
        """Return parameter ``name`` or ``default``."""
        return self._values.get(name, default)


class State(dict):
    """Per-node persistent dict, also accessible as attributes (``state.x``)."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError:
            raise AttributeError(f"state has no key {name!r}") from None

    def __setattr__(self, name: str, value: Any) -> None:
        self[name] = value
