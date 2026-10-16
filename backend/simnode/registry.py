"""Registry of block types, so front ends can list and create blocks."""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable

from .core.node import Node

_REGISTRY: dict[str, BlockType] = {}


@dataclass(frozen=True)
class BlockType:
    """A creatable block type.

    Attributes:
        type_name: Unique identifier used in diagrams (e.g. ``"Gain"``).
        factory: Callable ``factory(name, **params) -> Node``.
        category: Palette group (e.g. ``"Sources"``).
        description: One-line help text.
    """

    type_name: str
    factory: Callable[..., Node]
    category: str
    description: str

    def default_params(self) -> dict[str, Any]:
        """Constructor parameters (except ``name``) with their defaults.

        Tuples are returned as lists so the result is JSON-friendly;
        parameters without a default map to None.
        """
        params: dict[str, Any] = {}
        for pname, param in inspect.signature(self.factory).parameters.items():
            if pname == "name" or param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
                continue
            default = None if param.default is param.empty else param.default
            params[pname] = list(default) if isinstance(default, tuple) else default
        return params


def register(type_name: str, category: str) -> Callable[[type], type]:
    """Class decorator registering a ``Node`` subclass as a block type."""

    def deco(cls: type) -> type:
        if type_name in _REGISTRY:
            raise ValueError(f"block type {type_name!r} already registered")
        doc = (cls.__doc__ or "").strip().splitlines()
        _REGISTRY[type_name] = BlockType(type_name, cls, category, doc[0] if doc else "")
        cls.type_name = type_name
        return cls

    return deco


def block_types() -> dict[str, BlockType]:
    """Return all registered block types by name."""
    _load_builtins()
    return dict(_REGISTRY)


def create(type_name: str, name: str, **params: Any) -> Node:
    """Instantiate block ``type_name`` as node ``name``."""
    _load_builtins()
    try:
        block = _REGISTRY[type_name]
    except KeyError:
        raise KeyError(f"unknown block type {type_name!r}") from None
    return block.factory(name, **params)


def _load_builtins() -> None:
    from . import blocks  # noqa: F401 - importing registers the standard library
