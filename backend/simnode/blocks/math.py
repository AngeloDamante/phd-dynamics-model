"""Math operations. They fire on message by default, like ROS subscribers."""

from __future__ import annotations

from ..core import Inputs, Node, OnMessage, Outputs, Params, State
from ..registry import register


@register("Gain", "Math")
class Gain(Node):
    """Publish ``k * u`` whenever ``u`` arrives."""

    def __init__(self, name: str, k: float = 1.0) -> None:
        super().__init__(name, inputs=["u"], outputs=["y"], params={"k": k},
                         trigger=OnMessage())

    def step(self, t: float, inp: Inputs, out: Outputs, p: Params, state: State) -> None:
        out.y = p.k * inp.u


@register("Sum", "Math")
class Sum(Node):
    """Signed sum of inputs ``in1..inN``; ``signs`` like ``"+-"``."""

    def __init__(self, name: str, signs: str = "++") -> None:
        if not signs or set(signs) - {"+", "-"}:
            raise ValueError(f"signs must be a non-empty string of '+'/'-', got {signs!r}")
        inputs = [f"in{i + 1}" for i in range(len(signs))]
        super().__init__(name, inputs=inputs, outputs=["y"], params={"signs": signs},
                         trigger=OnMessage())

    def step(self, t: float, inp: Inputs, out: Outputs, p: Params, state: State) -> None:
        total = 0.0
        for i, sign in enumerate(p.signs):
            v = inp[f"in{i + 1}"]
            if v is None:
                v = 0.0
            total = total + v if sign == "+" else total - v
        out.y = total
