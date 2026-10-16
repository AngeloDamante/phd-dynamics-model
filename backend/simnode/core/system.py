"""Systems (graphs of nodes and wires) and subsystems (systems as nodes)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterator, Union

from .node import Node
from .port import PortError, PortSpec, dtypes_compatible


@dataclass(frozen=True)
class Endpoint:
    """A port on a named node within one system: ``node.port``."""

    node: str
    port: str

    @classmethod
    def parse(cls, ref: EndpointRef) -> Endpoint:
        """Build an endpoint from ``"node.port"``, a tuple, or an Endpoint."""
        if isinstance(ref, Endpoint):
            return ref
        if isinstance(ref, tuple):
            return cls(*ref)
        node, sep, port = ref.rpartition(".")
        if not sep or not node or not port:
            raise PortError(f"endpoint must look like 'node.port', got {ref!r}")
        return cls(node, port)

    def __str__(self) -> str:
        return f"{self.node}.{self.port}"


EndpointRef = Union[str, tuple[str, str], Endpoint]


@dataclass(frozen=True)
class Wire:
    """Connection from an output endpoint to an input endpoint."""

    src: Endpoint
    dst: Endpoint


class System:
    """A graph of nodes connected by wires.

    Each input port has at most one driver; an output port may fan out to
    any number of inputs.
    """

    def __init__(self) -> None:
        self.nodes: dict[str, Node] = {}
        self.wires: list[Wire] = []

    def add(self, node: Node) -> Node:
        """Add ``node`` and return it."""
        if node.name in self.nodes:
            raise ValueError(f"a node named {node.name!r} already exists")
        self.nodes[node.name] = node
        return node

    def remove(self, name: str) -> None:
        """Remove node ``name`` and every wire touching it."""
        del self.nodes[name]
        self.wires = [w for w in self.wires if name not in (w.src.node, w.dst.node)]

    def connect(self, src: EndpointRef, dst: EndpointRef) -> Wire:
        """Wire output ``src`` to input ``dst`` (e.g. ``"pid.u"``, ``"plant.u"``)."""
        s, d = Endpoint.parse(src), Endpoint.parse(dst)
        s_spec = self._node(s.node).output(s.port)
        d_spec = self._node(d.node).input(d.port)
        if self.driver(d) is not None:
            raise PortError(f"input {d} is already connected")
        if not dtypes_compatible(s_spec.dtype, d_spec.dtype):
            raise PortError(f"type mismatch: {s} is {s_spec.dtype}, {d} is {d_spec.dtype}")
        wire = Wire(s, d)
        self.wires.append(wire)
        return wire

    def disconnect(self, dst: EndpointRef) -> None:
        """Remove the wire driving input ``dst``."""
        d = Endpoint.parse(dst)
        self.wires = [w for w in self.wires if w.dst != d]

    def driver(self, dst: EndpointRef) -> Endpoint | None:
        """Return the output endpoint driving input ``dst``, if any."""
        d = Endpoint.parse(dst)
        for w in self.wires:
            if w.dst == d:
                return w.src
        return None

    def _node(self, name: str) -> Node:
        try:
            return self.nodes[name]
        except KeyError:
            raise PortError(f"no node named {name!r}") from None

    def __iter__(self) -> Iterator[Node]:
        return iter(self.nodes.values())


class Inport(Node):
    """Boundary input of a subsystem; its name becomes the subsystem's port."""

    def __init__(self, name: str, dtype: str | None = None, default: Any = None) -> None:
        super().__init__(name, outputs=[PortSpec("y", dtype, default)], params={"dtype": dtype})
        self.port_spec = PortSpec(name, dtype, default)


class Outport(Node):
    """Boundary output of a subsystem; its name becomes the subsystem's port."""

    def __init__(self, name: str, dtype: str | None = None, default: Any = None) -> None:
        super().__init__(name, inputs=[PortSpec("u", dtype, default)], params={"dtype": dtype})
        self.port_spec = PortSpec(name, dtype, default)


class Subsystem(Node):
    """A :class:`System` exposed as a single node.

    Its input/output ports are the ``Inport``/``Outport`` nodes inside
    ``system``, in insertion order. Subsystems are flattened before
    simulation, so they add no execution overhead or delay.
    """

    def __init__(self, name: str, system: System | None = None) -> None:
        super().__init__(name)
        self.system = system if system is not None else System()

    @property
    def inputs(self) -> tuple[PortSpec, ...]:
        return tuple(n.port_spec for n in self.system if isinstance(n, Inport))

    @property
    def outputs(self) -> tuple[PortSpec, ...]:
        return tuple(n.port_spec for n in self.system if isinstance(n, Outport))
