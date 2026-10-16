"""Signal sinks."""

from __future__ import annotations

from ..core import Node, OnMessage
from ..registry import register


@register("Scope", "Sinks")
class Scope(Node):
    """Live plot of its inputs. Recording is done by the front end."""

    def __init__(self, name: str, n_inputs: int = 1) -> None:
        if n_inputs < 1:
            raise ValueError("a scope needs at least one input")
        super().__init__(name, inputs=[f"in{i + 1}" for i in range(n_inputs)],
                         params={"n_inputs": n_inputs}, trigger=OnMessage())
