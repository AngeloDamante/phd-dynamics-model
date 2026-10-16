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
    """Raised when a feedback loop has no delay to break it.

    Attributes:
        paths: Node paths involved in the loop.
    """

    def __init__(self, message: str, paths: list[str] | None = None) -> None:
        super().__init__(message)
        self.paths = paths or []


@dataclass
class FlatGraph:
    """Result of :func:`flatten`.

    Attributes:
        leaves: Executable nodes by path, in depth-first insertion order.
        drivers: For each connected leaf input, the leaf output driving it.
    """

    leaves: dict[str, Node] = field(default_factory=dict)
    drivers: dict[PortRef, PortRef] = field(default_factory=dict)
    nodes: dict[str, Node] = field(default_factory=dict, repr=False)
    wiring: dict[PortRef, PortRef] = field(default_factory=dict, repr=False)

    def resolve_output(self, path: str, port: str) -> PortRef | None:
        """Resolve any output endpoint (leaf, ``Inport`` or ``Subsystem``) to
        the leaf output that drives it, or None if nothing does."""
        return self._resolve((path, port), frozenset())

    def output_aliases(self) -> dict[PortRef, PortRef]:
        """Map every output endpoint at every level to its driving leaf output."""
        aliases: dict[PortRef, PortRef] = {}
        for path, node in self.nodes.items():
            for spec in node.outputs:
                leaf = self.resolve_output(path, spec.name)
                if leaf is not None:
                    aliases[(path, spec.name)] = leaf
        return aliases

    def _resolve(self, src: PortRef, seen: frozenset[PortRef]) -> PortRef | None:
        if src in seen:
            raise AlgebraicLoopError(
                f"wire loop through subsystem boundary at {src[0]}.{src[1]}", [src[0]])
        path, port = src
        node = self.nodes[path]
        if isinstance(node, Subsystem):
            upstream = self.wiring.get((f"{path}/{port}", "u"))
        elif isinstance(node, Inport):
            parent = path.rpartition("/")[0]
            upstream = self.wiring.get((parent, node.name)) if parent else None
        else:
            return src
        return self._resolve(upstream, seen | {src}) if upstream else None

    def subscribers(self) -> dict[PortRef, list[PortRef]]:
        """Invert ``drivers``: leaf output -> leaf inputs it feeds."""
        subs: dict[PortRef, list[PortRef]] = {}
        for dst, src in self.drivers.items():
            subs.setdefault(src, []).append(dst)
        return subs


def flatten(system: System) -> FlatGraph:
    """Flatten ``system`` and all nested subsystems."""
    graph = FlatGraph()

    def walk(sys: System, prefix: str) -> None:
        for node in sys:
            path = prefix + node.name
            graph.nodes[path] = node
            if isinstance(node, Subsystem):
                walk(node.system, path + "/")
            elif not isinstance(node, (Inport, Outport)):
                graph.leaves[path] = node
        for w in sys.wires:
            graph.wiring[(prefix + w.dst.node, w.dst.port)] = (prefix + w.src.node, w.src.port)

    walk(system, "")
    for dst, src in graph.wiring.items():
        if dst[0] in graph.leaves:
            leaf_src = graph.resolve_output(*src)
            if leaf_src is not None:
                graph.drivers[dst] = leaf_src
    return graph
