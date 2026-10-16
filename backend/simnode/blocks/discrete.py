"""Discrete-time blocks."""

from __future__ import annotations

from ..core import Inputs, Node, Outputs, Params, Periodic, State
from ..registry import register


@register("UnitDelay", "Discrete")
class UnitDelay(Node):
    """Output the input of the previous sample; breaks feedback loops."""

    def __init__(self, name: str, initial: float = 0.0, sample_time: float = 0.01) -> None:
        super().__init__(name, inputs=["u"], outputs=["y"], params={"initial": initial},
                         trigger=Periodic(sample_time), direct_feedthrough=False)

    def step(self, t: float, inp: Inputs, out: Outputs, p: Params, state: State) -> None:
        # Non-feedthrough: fires before the rest of the tick, so ``inp.u``
        # is still the value from the previous sample.
        out.y = inp.u if inp.received("u") else p.initial
