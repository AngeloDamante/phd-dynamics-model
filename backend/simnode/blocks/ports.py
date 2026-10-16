"""Subsystem and boundary-port blocks, registered for the palette."""

from __future__ import annotations

from ..core import Inport, Outport, Subsystem
from ..registry import register


@register("Inport", "Ports & Subsystems")
class InportBlock(Inport):
    """Subsystem input; its name becomes the subsystem's input port."""


@register("Outport", "Ports & Subsystems")
class OutportBlock(Outport):
    """Subsystem output; its name becomes the subsystem's output port."""


@register("Subsystem", "Ports & Subsystems")
class SubsystemBlock(Subsystem):
    """Group of nodes exposed as a single node."""
