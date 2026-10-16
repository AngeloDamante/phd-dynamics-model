"""User-defined node with a Python callback, like a MATLAB Function block."""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from ..core import Node, OnMessage, Periodic, compile_step
from ..core.node import PortDecl
from ..registry import register

DEFAULT_CODE = '''\
def step(t, inp, out, p, state):
    # inp.<name>        latest value on an input (port default until the first message)
    # inp.fresh(name)   True if a new message arrived since the last call
    # out.<name> = v    publish v on an output
    # p.<name>          parameters (read-only)
    # state             dict kept between calls, e.g. state.x = state.get("x", 0.0)
    out.y = inp.u
'''


@register("PythonNode", "User-Defined")
class PythonNode(Node):
    """Node whose callback is user-written Python source.

    Args:
        name: Node name.
        code: Source defining ``step(t, inp, out, p, state)``.
        inputs / outputs: Port declarations (see :data:`~simnode.core.node.PortDecl`).
        params: Parameters available as ``p``.
        sample_time: If given, fire periodically; otherwise fire on message.
        trigger_ports: For on-message nodes, inputs that trigger the
            callback (default: any input).
        direct_feedthrough: See :class:`~simnode.core.Node`.
    """

    def __init__(self, name: str, code: str = DEFAULT_CODE,
                 inputs: Iterable[PortDecl] = ("u",),
                 outputs: Iterable[PortDecl] = ("y",),
                 params: Mapping[str, Any] | None = None,
                 sample_time: float | None = None,
                 trigger_ports: Iterable[str] | None = None,
                 direct_feedthrough: bool = True) -> None:
        if sample_time is not None:
            trigger = Periodic(sample_time)
        else:
            trigger = OnMessage(tuple(trigger_ports) if trigger_ports is not None else None)
        super().__init__(name, inputs=inputs, outputs=outputs, params=params,
                         trigger=trigger, step=compile_step(code, f"<{name}>"),
                         direct_feedthrough=direct_feedthrough)
        self.code = code
