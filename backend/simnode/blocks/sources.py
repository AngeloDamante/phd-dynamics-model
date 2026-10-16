"""Signal sources."""

from __future__ import annotations

import math

from ..core import Inputs, Node, Outputs, Params, Periodic, State
from ..registry import register


@register("Constant", "Sources")
class Constant(Node):
    """Publish a constant value every sample time."""

    def __init__(self, name: str, value: float = 0.0, sample_time: float = 1.0) -> None:
        super().__init__(name, outputs=["y"], params={"value": value},
                         trigger=Periodic(sample_time))

    def step(self, t: float, inp: Inputs, out: Outputs, p: Params, state: State) -> None:
        out.y = p.value


@register("Step", "Sources")
class Step(Node):
    """Jump from ``initial`` to ``final`` at ``step_time``."""

    def __init__(self, name: str, step_time: float = 1.0, initial: float = 0.0,
                 final: float = 1.0, sample_time: float = 0.01) -> None:
        super().__init__(name, outputs=["y"], trigger=Periodic(sample_time),
                         params={"step_time": step_time, "initial": initial, "final": final})

    def step(self, t: float, inp: Inputs, out: Outputs, p: Params, state: State) -> None:
        out.y = p.final if t >= p.step_time else p.initial


@register("Sine", "Sources")
class Sine(Node):
    """``bias + amplitude * sin(2*pi*frequency*t + phase)``, frequency in Hz."""

    def __init__(self, name: str, amplitude: float = 1.0, frequency: float = 1.0,
                 phase: float = 0.0, bias: float = 0.0, sample_time: float = 0.01) -> None:
        super().__init__(name, outputs=["y"], trigger=Periodic(sample_time),
                         params={"amplitude": amplitude, "frequency": frequency,
                                 "phase": phase, "bias": bias})

    def step(self, t: float, inp: Inputs, out: Outputs, p: Params, state: State) -> None:
        out.y = p.bias + p.amplitude * math.sin(2 * math.pi * p.frequency * t + p.phase)
