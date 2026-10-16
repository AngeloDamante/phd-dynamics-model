"""REST + WebSocket API.

REST:
    GET  /api/blocks                 block palette (types, params, default ports)
    POST /api/blocks/ports           ports of a block for given params
    POST /api/code/check             syntax-check callback source (no execution)
    GET  /api/diagrams               saved diagram names
    GET  /api/diagrams/{name}        load (404 if missing)
    PUT  /api/diagrams/{name}        save (validated)
    DELETE /api/diagrams/{name}

WebSocket ``/api/sim``: one simulation per connection. The client sends
``{"cmd": "start", "diagram": {...}, "monitors": [...]}`` and then any
:mod:`simnode.runner` command; the server forwards runner events, plus
``{"type": "stopped", "killed": bool}`` after a stop.

The server binds to localhost by default: diagrams contain arbitrary Python
that is executed on this machine.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .. import registry
from ..codecheck import check_callback_source
from ..core.node import as_spec
from ..io import DiagramError, validate_diagram
from ..runner import SimProcess

NAME_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
FRONTEND_DIST = Path(__file__).resolve().parents[3] / "frontend" / "dist"


def _port_json(specs: Any) -> list[dict]:
    return [{"name": s.name, "dtype": s.dtype} for s in specs]


def block_ports(type_name: str, params: dict) -> dict:
    """Ports of block ``type_name`` built with ``params``.

    PythonNode ports are read from its declared params without compiling
    the user code, so this never executes user callbacks.
    """
    if type_name == "PythonNode":
        return {"inputs": _port_json(as_spec(p) for p in params.get("inputs") or []),
                "outputs": _port_json(as_spec(p) for p in params.get("outputs") or [])}
    if type_name == "Subsystem":
        raise ValueError("subsystem ports are defined by its Inport/Outport blocks")
    node = registry.create(type_name, "probe", **params)
    return {"inputs": _port_json(node.inputs), "outputs": _port_json(node.outputs)}


def create_app(diagram_dir: str | Path = "diagrams") -> FastAPI:
    """Build the FastAPI app, storing diagrams as JSON files in ``diagram_dir``."""
    app = FastAPI(title="simnode")
    store = Path(diagram_dir)

    def diagram_path(name: str) -> Path:
        if not NAME_RE.match(name):
            raise HTTPException(400, "diagram names may only contain letters, digits, _ and -")
        return store / f"{name}.json"

    @app.get("/api/blocks")
    def list_blocks() -> list[dict]:
        out = []
        for type_name, bt in registry.block_types().items():
            params = bt.default_params()
            params.pop("system", None)
            entry = {"type": type_name, "category": bt.category,
                     "description": bt.description, "params": params}
            if type_name != "Subsystem":
                entry.update(block_ports(type_name, params))
            else:
                entry.update({"inputs": [], "outputs": []})
            out.append(entry)
        return out

    @app.post("/api/blocks/ports")
    def ports(body: dict = Body(...)) -> dict:
        try:
            return block_ports(body["type"], body.get("params") or {})
        except Exception as exc:  # noqa: BLE001 - report invalid params to the editor
            raise HTTPException(400, f"{type(exc).__name__}: {exc}") from exc

    @app.post("/api/code/check")
    def check_code(body: dict = Body(...)) -> dict:
        return {"problems": check_callback_source(str(body.get("code", "")))}

    @app.get("/api/diagrams")
    def list_diagrams() -> list[str]:
        return sorted(p.stem for p in store.glob("*.json")) if store.is_dir() else []

    @app.get("/api/diagrams/{name}")
    def load_diagram(name: str) -> dict:
        path = diagram_path(name)
        if not path.is_file():
            raise HTTPException(404, f"no diagram named {name!r}")
        try:
            return validate_diagram(json.loads(path.read_text()))
        except (json.JSONDecodeError, DiagramError) as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.put("/api/diagrams/{name}")
    def save_diagram(name: str, doc: dict = Body(...)) -> dict:
        path = diagram_path(name)
        try:
            doc = validate_diagram(doc)
        except DiagramError as exc:
            raise HTTPException(422, str(exc)) from exc
        doc["name"] = name
        store.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=2))
        tmp.replace(path)
        return {"ok": True, "name": name}

    @app.delete("/api/diagrams/{name}")
    def delete_diagram(name: str) -> dict:
        path = diagram_path(name)
        if not path.is_file():
            raise HTTPException(404, f"no diagram named {name!r}")
        path.unlink()
        return {"ok": True}

    @app.websocket("/api/sim")
    async def sim_socket(ws: WebSocket) -> None:
        await ws.accept()
        session = _SimSession(ws)
        try:
            while True:
                await session.handle(await ws.receive_json())
        except WebSocketDisconnect:
            pass
        finally:
            await session.close()

    if FRONTEND_DIST.is_dir():
        app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

        @app.get("/")
        def index() -> FileResponse:
            return FileResponse(FRONTEND_DIST / "index.html")

    return app


class _SimSession:
    """One WebSocket client and its (optional) running simulation."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.proc: SimProcess | None = None
        self.pump: asyncio.Task | None = None

    async def handle(self, msg: dict) -> None:
        cmd = msg.get("cmd")
        if cmd == "start":
            await self.close()
            self.proc = SimProcess(msg.get("diagram") or {}, msg.get("monitors") or [])
            self.proc.start()
            self.pump = asyncio.create_task(self._pump(self.proc))
        elif cmd == "stop":
            await self.close(notify=True)
        elif self.proc is not None:
            self.proc.send(msg)

    async def _pump(self, proc: SimProcess) -> None:
        while True:
            event = await asyncio.to_thread(proc.get_event, 0.1)
            if event is not None:
                await self.ws.send_json(event)
            elif not proc.alive:
                # Drain anything flushed right before exit.
                while (event := await asyncio.to_thread(proc.get_event, 0.05)) is not None:
                    await self.ws.send_json(event)
                return

    async def close(self, notify: bool = False) -> None:
        proc, pump = self.proc, self.pump
        self.proc = self.pump = None
        if proc is None:
            return
        killed = await asyncio.to_thread(proc.stop, 1.0)
        if pump is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(pump, 1.0)
            pump.cancel()
        if notify:
            with contextlib.suppress(Exception):
                await self.ws.send_json({"type": "stopped", "killed": killed})
