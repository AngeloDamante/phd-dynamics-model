"""The ``Node`` base class: the atomic, ROS-node-like simulation unit."""

from __future__ import annotations

from typing import Any, Callable, Iterable, Mapping

from .port import PortError, PortSpec
from .runtime import Inputs, Outputs, Params, State
from .trigger import OnMessage, Trigger

#: Signature of a node callback: ``step(t, inp, out, p, state)``.
StepFn = Callable[[float, Inputs, Outputs, Params, State], None]


def _as_specs(ports: Iterable[PortSpec | str]) -> tuple[PortSpec, ...]:
    specs = tuple(p if isinstance(p, PortSpec) else PortSpec(p) for p in ports)
    names = [p.name for p in specs]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise PortError(f"duplicate port names: {sorted(dupes)}")
    return specs


def validate_name(name: str) -> str:
    """Validate a node name (non-empty, no ``/`` which separates paths)."""
    if not name or "/" in name or name != name.strip():
        raise ValueError(f"invalid node name {name!r}")
    return name


class Node:
    """A simulation node with input/output ports, parameters and a callback.

    The callback is either passed as ``step`` or provided by overriding
    :meth:`step` in a subclass.

    Args:
        name: Unique name within the parent system.
        inputs: Input ports (subscribers); strings are shorthand for
            untyped ``PortSpec``.
        outputs: Output ports (publishers).
        params: Parameters exposed to the callback as ``p``.
        trigger: ``Periodic(sample_time)`` or ``OnMessage(ports)``.
            Defaults to ``OnMessage()`` (fire on any input).
        step: Callback ``step(t, inp, out, p, state)``.
        direct_feedthrough: If False, the node fires before all
            feedthrough nodes in a tick and therefore sees the previous
            tick's input values. This is what breaks feedback loops
            (e.g. ``UnitDelay``).
    """

    def __init__(
        self,
        name: str,
        inputs: Iterable[PortSpec | str] = (),
        outputs: Iterable[PortSpec | str] = (),
        params: Mapping[str, Any] | None = None,
        trigger: Trigger | None = None,
        step: StepFn | None = None,
        direct_feedthrough: bool = True,
    ) -> None:
        self.name = validate_name(name)
        self._inputs = _as_specs(inputs)
        self._outputs = _as_specs(outputs)
        self.params: dict[str, Any] = dict(params or {})
        self.trigger: Trigger = trigger if trigger is not None else OnMessage()
        self.direct_feedthrough = direct_feedthrough
        self._step_fn = step
        if isinstance(self.trigger, OnMessage) and self.trigger.ports is not None:
            unknown = set(self.trigger.ports) - {p.name for p in self.inputs}
            if unknown:
                raise PortError(f"{name}: trigger ports {sorted(unknown)} are not inputs")

    @property
    def inputs(self) -> tuple[PortSpec, ...]:
        """Input port specs, in declaration order."""
        return self._inputs

    @property
    def outputs(self) -> tuple[PortSpec, ...]:
        """Output port specs, in declaration order."""
        return self._outputs

    def input(self, name: str) -> PortSpec:
        """Return the input port spec called ``name``."""
        for spec in self.inputs:
            if spec.name == name:
                return spec
        raise PortError(f"{self.name}: no input port {name!r}")

    def output(self, name: str) -> PortSpec:
        """Return the output port spec called ``name``."""
        for spec in self.outputs:
            if spec.name == name:
                return spec
        raise PortError(f"{self.name}: no output port {name!r}")

    def step(self, t: float, inp: Inputs, out: Outputs, p: Params, state: State) -> None:
        """Node callback. Override in subclasses or pass ``step=`` to init."""
        if self._step_fn is not None:
            self._step_fn(t, inp, out, p, state)

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.name!r})"
