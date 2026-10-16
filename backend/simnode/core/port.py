"""Port specifications: the named input/output slots of a node."""

from __future__ import annotations

import keyword
from dataclasses import dataclass
from typing import Any

#: Names used by the callback-facing ``Inputs`` API; ports cannot shadow them.
RESERVED_PORT_NAMES = frozenset({"fresh", "received"})


class PortError(ValueError):
    """Raised for invalid port declarations or connections."""


@dataclass(frozen=True)
class PortSpec:
    """Declaration of a single input or output port.

    Attributes:
        name: Port name; must be a valid Python identifier so callbacks can
            use ``inp.<name>`` / ``out.<name>``.
        dtype: Optional message type (e.g. ``"Float64"``). When both ends of
            a wire declare a type, they must match.
        default: Value seen on an input before any message arrives, or held
            by an output before it is first published.
    """

    name: str
    dtype: str | None = None
    default: Any = None

    def __post_init__(self) -> None:
        if not self.name.isidentifier() or keyword.iskeyword(self.name):
            raise PortError(f"invalid port name {self.name!r}: must be a Python identifier")
        if self.name.startswith("_") or self.name in RESERVED_PORT_NAMES:
            raise PortError(f"port name {self.name!r} is reserved")


def dtypes_compatible(a: str | None, b: str | None) -> bool:
    """Return True if two optional port types may be connected."""
    return a is None or b is None or a == b
