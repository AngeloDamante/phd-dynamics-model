"""Trigger modes deciding when a node's callback fires."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Union


@dataclass(frozen=True)
class Periodic:
    """Fire every ``sample_time`` seconds of simulated time (like a ROS timer)."""

    sample_time: float

    def __post_init__(self) -> None:
        if not self.sample_time > 0:
            raise ValueError(f"sample_time must be > 0, got {self.sample_time}")


@dataclass(frozen=True)
class OnMessage:
    """Fire when a message arrives on one of ``ports`` (like a ROS subscriber).

    ``ports=None`` means any input port triggers the callback.
    """

    ports: tuple[str, ...] | None = None


Trigger = Union[Periodic, OnMessage]
