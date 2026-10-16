"""Discrete-time scheduler executing a flattened system.

Execution model, per tick of the base step (GCD of all sample times):

1. Nodes with ``direct_feedthrough=False`` (e.g. ``UnitDelay``) fire
   first, seeing the values as of the end of the previous tick.
2. All other nodes fire in topological order of their data dependencies,
   so a downstream node sees values published upstream in the same tick.

A node fires if it is ``Periodic`` and due on this tick, or if it is
``OnMessage`` and one of its trigger inputs received a message. Because of
the ordering, an on-message node fires at most once per tick even with
several updated inputs. A trigger that cannot be served in the current
pass (e.g. on a non-feedthrough node) fires on the next tick.

A dependency cycle among feedthrough nodes is an algebraic loop and is
rejected; insert a ``UnitDelay`` to break it.
"""

from __future__ import annotations

import math
import traceback
from fractions import Fraction
from typing import Any, Callable

from .flatten import AlgebraicLoopError, FlatGraph, PortRef, flatten
from .node import Node
from .runtime import Inputs, Outputs, Params, State
from .system import System
from .trigger import OnMessage, Periodic

#: Called on every publish as ``listener(t, path, port, value)``.
Listener = Callable[[float, str, str, Any], None]


class CallbackError(RuntimeError):
    """A node callback raised; carries the node path and sim time."""

    def __init__(self, path: str, t: float, original: BaseException) -> None:
        self.path = path
        self.t = t
        self.original = original
        self.traceback = "".join(traceback.format_exception(original))
        super().__init__(f"{path} at t={t:g}: {type(original).__name__}: {original}")


def _to_fraction(x: float) -> Fraction:
    return Fraction(x).limit_denominator(10**9)


def _gcd(values: list[Fraction]) -> Fraction:
    num = 0
    den = 1
    for v in values:
        den = den * v.denominator // math.gcd(den, v.denominator)
    for v in values:
        num = math.gcd(num, v.numerator * (den // v.denominator))
    return Fraction(num, den)


def execution_order(graph: FlatGraph) -> list[str]:
    """Return leaf paths in firing order (see module docstring)."""
    leaves = graph.leaves
    early = [p for p, n in leaves.items() if not n.direct_feedthrough]
    rank = {p: i for i, p in enumerate(leaves)}
    deps: dict[str, set[str]] = {p: set() for p in leaves if leaves[p].direct_feedthrough}
    for (dst, _), (src, _) in graph.drivers.items():
        if dst in deps and src in deps and src != dst:
            deps[dst].add(src)
        elif dst == src and dst in deps:
            raise AlgebraicLoopError(f"algebraic loop: {dst} feeds itself")
    order: list[str] = []
    ready = sorted((p for p, d in deps.items() if not d), key=rank.__getitem__)
    while ready:
        p = ready.pop(0)
        order.append(p)
        for q, d in deps.items():
            if p in d:
                d.discard(p)
                if not d:
                    ready.append(q)
        ready.sort(key=rank.__getitem__)
        deps.pop(p)
    if deps:
        raise AlgebraicLoopError(f"algebraic loop among: {', '.join(sorted(deps))}")
    return early + order


class Simulation:
    """Runtime for one simulation of a :class:`System`.

    Args:
        system: The (possibly nested) system to simulate.
        base_step: Optional extra step to include in the base-step GCD;
            required if no node is periodic.
    """

    def __init__(self, system: System, base_step: float | None = None) -> None:
        self.graph = flatten(system)
        self.order = execution_order(self.graph)
        self._subscribers = self.graph.subscribers()
        steps = [_to_fraction(n.trigger.sample_time)
                 for n in self.graph.leaves.values() if isinstance(n.trigger, Periodic)]
        if base_step is not None:
            steps.append(_to_fraction(base_step))
        if not steps:
            raise ValueError("no periodic node: pass base_step explicitly")
        self._base = _gcd(steps)
        self._period: dict[str, int] = {
            p: int(_to_fraction(n.trigger.sample_time) / self._base)
            for p, n in self.graph.leaves.items() if isinstance(n.trigger, Periodic)
        }
        self._values: dict[PortRef, Any] = {}
        self._received: dict[str, set[str]] = {}
        self._fresh: dict[str, set[str]] = {}
        self._states: dict[str, State] = {}
        self._params: dict[str, Params] = {}
        self._pending: set[str] = set()
        self._listeners: list[Listener] = []
        self.tick = 0
        self.reset()

    @property
    def dt(self) -> float:
        """Base step in seconds."""
        return float(self._base)

    @property
    def time(self) -> float:
        """Simulated time of the next tick to execute."""
        return float(self.tick * self._base)

    def add_listener(self, listener: Listener) -> None:
        """Register a callback invoked on every publish."""
        self._listeners.append(listener)

    def reset(self) -> None:
        """Return to t=0 with fresh state and default port values."""
        self.tick = 0
        self._values = {(p, o.name): o.default
                        for p, n in self.graph.leaves.items() for o in n.outputs}
        self._received = {p: set() for p in self.graph.leaves}
        self._fresh = {p: set() for p in self.graph.leaves}
        self._states = {p: State() for p in self.graph.leaves}
        self._params = {p: Params(n.params) for p, n in self.graph.leaves.items()}
        self._pending = set()

    def value(self, path: str, port: str) -> Any:
        """Latest value on leaf output ``path.port``."""
        return self._values[(path, port)]

    def input_value(self, path: str, port: str) -> Any:
        """Value currently seen by leaf input ``path.port``."""
        src = self.graph.drivers.get((path, port))
        if src is not None:
            return self._values[src]
        return self.graph.leaves[path].input(port).default

    def step(self) -> None:
        """Execute one tick at :attr:`time`, then advance."""
        t = self.time
        for path in self.order:
            period = self._period.get(path)
            due = period is not None and self.tick % period == 0
            if due or path in self._pending:
                self._pending.discard(path)
                self._fire(path, t)
        self.tick += 1

    def run(self, until: float) -> None:
        """Execute ticks while ``time <= until``."""
        end = _to_fraction(until)
        while self.tick * self._base <= end:
            self.step()

    def _fire(self, path: str, t: float) -> None:
        node: Node = self.graph.leaves[path]
        values = {spec.name: self.input_value(path, spec.name) for spec in node.inputs}
        inp = Inputs(values, self._fresh[path], self._received[path])
        out = Outputs(frozenset(o.name for o in node.outputs))
        try:
            node.step(t, inp, out, self._params[path], self._states[path])
        except Exception as exc:  # noqa: BLE001 - surfaced with node context
            raise CallbackError(path, t, exc) from exc
        self._fresh[path] = set()
        for port, value in out._published.items():
            self._publish(t, path, port, value)

    def _publish(self, t: float, path: str, port: str, value: Any) -> None:
        self._values[(path, port)] = value
        for listener in self._listeners:
            listener(t, path, port, value)
        for sub_path, sub_port in self._subscribers.get((path, port), ()):
            self._fresh[sub_path].add(sub_port)
            self._received[sub_path].add(sub_port)
            trig = self.graph.leaves[sub_path].trigger
            if isinstance(trig, OnMessage) and (trig.ports is None or sub_port in trig.ports):
                self._pending.add(sub_path)
