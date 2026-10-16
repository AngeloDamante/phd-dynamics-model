"""Flatten nested subsystems into leaf nodes connected directly.

Leaf paths are ``/``-joined node names (e.g. ``"ctrl/pid"``). ``Inport``,
``Outport`` and ``Subsystem`` nodes are pure wiring and disappear: every
leaf input is resolved to the leaf output that ultimately drives it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .node import Node
from .system import Inport, Outport, Subsystem, System

#: A port on a leaf node, as ``(path, port)``.
PortRef = tuple[str, str]


class AlgebraicLoopError(RuntimeError):
    """Raised when a feedback loop has no delay to break it."""


@dataclass
class FlatGraph:
    """Result of :func:`flatten`.

    Attributes:
        leaves: Executable nodes by path, in depth-first insertion order.
        drivers: For each connected leaf input, the leaf output driving it.
    """

    leaves: dict[str, Node] = field(default_factory=dict)
    drivers: dict[PortRef, PortRef] = field(default_factory=dict)

    def subscribers(self) -> dict[PortRef, list[PortRef]]:
        """Invert ``drivers``: leaf output -> leaf inputs it feeds."""
        subs: dict[PortRef, list[PortRef]] = {}
        for dst, src in self.drivers.items():
            subs.setdefault(src, []).append(dst)
        return subs


def flatten(system: System) -> FlatGraph:
    """Flatten ``system`` and all nested subsystems."""
    nodes: dict[str, Node] = {}
    raw: dict[PortRef, PortRef] = {}
    graph = FlatGraph()

    def walk(sys: System, prefix: str) -> None:
        for node in sys:
            path = prefix + node.name
            nodes[path] = node
            if isinstance(node, Subsystem):
                walk(node.system, path + "/")
            elif not isinstance(node, (Inport, Outport)):
                graph.leaves[path] = node
        for w in sys.wires:
            raw[(prefix + w.dst.node, w.dst.port)] = (prefix + w.src.node, w.src.port)

    def resolve(src: PortRef, seen: frozenset[PortRef]) -> PortRef | None:
        if src in seen:
            raise AlgebraicLoopError(f"wire loop through subsystem boundary at {src[0]}.{src[1]}")
        path, port = src
        node = nodes[path]
        if isinstance(node, Subsystem):
            upstream = raw.get((f"{path}/{port}", "u"))
        elif isinstance(node, Inport):
            parent = path.rpartition("/")[0]
            upstream = raw.get((parent, node.name)) if parent else None
        else:
            return src
        return resolve(upstream, seen | {src}) if upstream else None

    walk(system, "")
    for dst, src in raw.items():
        if dst[0] in graph.leaves:
            leaf_src = resolve(src, frozenset())
            if leaf_src is not None:
                graph.drivers[dst] = leaf_src
    return graph
