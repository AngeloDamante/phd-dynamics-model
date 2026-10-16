"""Diagram documents: the versioned JSON format shared with the front end.

A diagram is a plain dict (JSON)::

    {
      "format": "simnode-diagram", "version": 1, "name": "demo",
      "sim": {"stop_time": 10.0, "base_step": null, "realtime": false, "speed": 1.0},
      "root": <system>
    }

    <system> = {"blocks": [<block>...], "wires": [<wire>...]}
    <block>  = {"id": "b1", "name": "pid", "type": "PythonNode",
                "params": {...}, "x": 100, "y": 80,
                "system": <system>}            # only for type "Subsystem"
    <wire>   = {"id": "w1", "src": {"block": "b1", "port": "u"},
                "dst": {"block": "b2", "port": "u"}, ...}

Wires reference blocks by ``id`` so renames don't break them. Layout and
UI-only keys (``x``, ``y``, ``vertices``, ``monitor``...) are preserved by
the front end and ignored here.
"""

from __future__ import annotations

import copy
from typing import Any, Callable

from .. import registry
from ..core import Subsystem, System

FORMAT = "simnode-diagram"
VERSION = 1

DEFAULT_SIM = {"stop_time": 10.0, "base_step": None, "realtime": False, "speed": 1.0}

#: ``MIGRATIONS[v]`` upgrades a version-``v`` document to ``v + 1``.
MIGRATIONS: dict[int, Callable[[dict], dict]] = {}


class DiagramError(ValueError):
    """Invalid diagram; ``path`` is the ``/``-joined block path, if known."""

    def __init__(self, message: str, path: str | None = None) -> None:
        super().__init__(f"{path}: {message}" if path else message)
        self.message = message
        self.path = path


def empty_diagram(name: str = "untitled") -> dict:
    """Return a new, empty diagram document."""
    return {"format": FORMAT, "version": VERSION, "name": name,
            "sim": dict(DEFAULT_SIM), "root": {"blocks": [], "wires": []}}


def validate_diagram(doc: Any) -> dict:
    """Check format/version, apply migrations and fill defaults.

    Returns a new document; the input is not modified.
    """
    if not isinstance(doc, dict) or doc.get("format") != FORMAT:
        raise DiagramError(f"not a {FORMAT} document")
    version = doc.get("version")
    if not isinstance(version, int) or version < 1:
        raise DiagramError(f"invalid version {version!r}")
    if version > VERSION:
        raise DiagramError(f"document version {version} is newer than supported ({VERSION})")
    doc = copy.deepcopy(doc)
    while doc["version"] < VERSION:
        doc = MIGRATIONS[doc["version"]](doc)
        doc["version"] += 1
    doc["sim"] = {**DEFAULT_SIM, **(doc.get("sim") or {})}
    doc.setdefault("name", "untitled")
    _check_system(doc.get("root"), "")
    return doc


def _check_system(sysdoc: Any, prefix: str) -> None:
    if not isinstance(sysdoc, dict):
        raise DiagramError("system must be an object", prefix.rstrip("/") or None)
    ids: set[str] = set()
    for block in sysdoc.setdefault("blocks", []):
        for key in ("id", "name", "type"):
            if not isinstance(block.get(key), str):
                raise DiagramError(f"block is missing string field {key!r}",
                                   prefix + str(block.get("name", "?")))
        if block["id"] in ids:
            raise DiagramError(f"duplicate block id {block['id']!r}", prefix.rstrip("/") or None)
        ids.add(block["id"])
        if block["type"] == "Subsystem":
            _check_system(block.setdefault("system", {"blocks": [], "wires": []}),
                          prefix + block["name"] + "/")
    for wire in sysdoc.setdefault("wires", []):
        for end in ("src", "dst"):
            ref = wire.get(end)
            if not isinstance(ref, dict) or ref.get("block") not in ids \
                    or not isinstance(ref.get("port"), str):
                raise DiagramError(f"wire {wire.get('id')!r} has an invalid {end}",
                                   prefix.rstrip("/") or None)


def build_system(sysdoc: dict, prefix: str = "") -> System:
    """Build a core :class:`System` from a ``<system>`` dict (recursively)."""
    system = System()
    names: dict[str, str] = {}
    for block in sysdoc.get("blocks", []):
        path = prefix + block["name"]
        try:
            if block["type"] == "Subsystem":
                node = Subsystem(block["name"], build_system(block["system"], path + "/"))
            else:
                node = registry.create(block["type"], block["name"], **block.get("params", {}))
            system.add(node)
        except DiagramError:
            raise
        except Exception as exc:  # noqa: BLE001 - attach the block path to any error
            raise DiagramError(str(exc), path) from exc
        names[block["id"]] = block["name"]
    for wire in sysdoc.get("wires", []):
        src, dst = wire["src"], wire["dst"]
        try:
            system.connect((names[src["block"]], src["port"]), (names[dst["block"]], dst["port"]))
        except Exception as exc:  # noqa: BLE001
            raise DiagramError(str(exc), prefix + names[dst["block"]]) from exc
    return system
