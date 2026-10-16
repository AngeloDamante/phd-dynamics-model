"""Run a diagram in a separate process and stream events back.

User callbacks run in the worker process, so a crash or an infinite loop
never takes down the caller: :meth:`SimProcess.stop` terminates a worker
that doesn't respond.

Commands (dicts sent with :meth:`SimProcess.send`)::

    {"cmd": "pause"} | {"cmd": "resume"} | {"cmd": "step"} | {"cmd": "stop"}
    {"cmd": "speed", "realtime": bool, "speed": float}
    {"cmd": "monitor", "endpoint": "path.port"} | {"cmd": "unmonitor", ...}

Events (dicts returned by :meth:`SimProcess.get_event`)::

    started  {dt, stop_time, aliases: {endpoint: leaf}, scopes: {path: [leaf|None]}}
    status   {state: "running"|"paused", t}
    data     {t, series: {key: [[t...], [v...]]}}
    topics   {t, topics: {leaf: {value, count, rate}}}
    error    {phase: "build"|"run", message, path, t, traceback}
    done     {t}

Endpoints and leaves are ``"path.port"`` strings. Series keys are leaf
keys, with ``[i]`` / ``.field`` suffixes for vector and dict payloads.
"""

from __future__ import annotations

import math
import multiprocessing as mp
import queue
import reprlib
import time
from typing import Any, Iterable

from .core import AlgebraicLoopError, CallbackError, Simulation
from .io import DiagramError, build_system, validate_diagram

FLUSH_INTERVAL = 0.05     # s of wall time between data events
TOPICS_INTERVAL = 0.25    # s of wall time between topics events
MAX_COMPONENTS = 64       # max plotted components per payload

_repr = reprlib.Repr()
_repr.maxstring = 60
_repr.maxother = 60


def key(path: str, port: str) -> str:
    """Endpoint key ``"path.port"``."""
    return f"{path}.{port}"


def split_key(k: str) -> tuple[str, str]:
    """Inverse of :func:`key`."""
    path, _, port = k.rpartition(".")
    return path, port


def numeric_components(value: Any, suffix: str = "") -> list[tuple[str, float | None]]:
    """Flatten a payload into plottable ``(suffix, number)`` pairs.

    Numbers map to themselves, sequences to ``[i]`` suffixes, mappings and
    objects with attributes to ``.field`` suffixes. NaN/inf become None so
    the result stays valid JSON. Non-numeric leaves are skipped.
    """
    out: list[tuple[str, float | None]] = []

    def visit(v: Any, s: str, depth: int) -> None:
        if len(out) >= MAX_COMPONENTS or depth > 4:
            return
        if isinstance(v, bool):
            out.append((s, float(v)))
        elif isinstance(v, (int, float)):
            f = float(v)
            out.append((s, f if math.isfinite(f) else None))
        elif hasattr(v, "tolist") and not isinstance(v, (str, bytes)):
            visit(v.tolist(), s, depth)  # numpy arrays and scalars
        elif isinstance(v, (list, tuple)):
            for i, item in enumerate(v):
                visit(item, f"{s}[{i}]", depth + 1)
        elif isinstance(v, dict):
            for k, item in v.items():
                visit(item, f"{s}.{k}", depth + 1)
        elif hasattr(v, "__dict__"):
            for k, item in vars(v).items():
                if not k.startswith("_"):
                    visit(item, f"{s}.{k}", depth + 1)

    visit(value, suffix, 0)
    return out


class _Worker:
    """Simulation loop living in the worker process."""

    def __init__(self, sim: Simulation, settings: dict, cmd_q: Any, emit: Any) -> None:
        self.sim = sim
        self.cmd_q = cmd_q
        self.emit = emit
        self.stop_time = float(settings["stop_time"])
        self.realtime = bool(settings["realtime"])
        self.speed = float(settings["speed"]) or 1.0
        self.paused = bool(settings.get("start_paused", False))
        self.running = True
        self.aliases = {key(*k): key(*v) for k, v in sim.graph.output_aliases().items()}
        self.monitored: set[str] = set()
        self.buffer: dict[str, tuple[list[float], list[float | None]]] = {}
        self.topic_count: dict[str, int] = {}
        self.topic_value: dict[str, Any] = {}
        self.last_topic_count: dict[str, int] = {}
        self.last_topics_t = 0.0
        self.scopes = {
            path: [self._leaf_of_driver(path, spec.name) for spec in node.inputs]
            for path, node in sim.graph.leaves.items()
            if getattr(node, "type_name", None) == "Scope"
        }
        for leaves in self.scopes.values():
            self.monitored.update(k for k in leaves if k)
        sim.add_listener(self._on_publish)
        self._anchor()

    def _leaf_of_driver(self, path: str, port: str) -> str | None:
        src = self.sim.graph.drivers.get((path, port))
        return key(*src) if src else None

    def _anchor(self) -> None:
        self.wall0 = time.monotonic()
        self.sim0 = self.sim.time

    def _on_publish(self, t: float, path: str, port: str, value: Any) -> None:
        k = key(path, port)
        self.topic_count[k] = self.topic_count.get(k, 0) + 1
        self.topic_value[k] = value
        if k in self.monitored:
            for suffix, v in numeric_components(value):
                ts, vs = self.buffer.setdefault(k + suffix, ([], []))
                ts.append(t)
                vs.append(v)

    def monitor(self, endpoint: str, on: bool) -> None:
        leaf = self.aliases.get(endpoint, endpoint)
        if on:
            self.monitored.add(leaf)
        elif not any(leaf in ks for ks in self.scopes.values()):
            self.monitored.discard(leaf)

    def flush(self) -> None:
        if self.buffer:
            series = {k: [ts, vs] for k, (ts, vs) in self.buffer.items()}
            self.buffer = {}
            self.emit({"type": "data", "t": self.sim.time, "series": series})

    def send_topics(self) -> None:
        t = self.sim.time
        span = t - self.last_topics_t
        topics = {}
        for k, count in self.topic_count.items():
            delta = count - self.last_topic_count.get(k, 0)
            topics[k] = {"value": _repr.repr(self.topic_value[k]), "count": count,
                         "rate": delta / span if span > 0 else None}
        self.last_topic_count = dict(self.topic_count)
        self.last_topics_t = t
        self.emit({"type": "topics", "t": t, "topics": topics})

    def status(self) -> None:
        self.emit({"type": "status", "state": "paused" if self.paused else "running",
                   "t": self.sim.time})

    def handle(self, msg: dict) -> None:
        cmd = msg.get("cmd")
        if cmd == "pause":
            self.paused = True
            self.flush()
            self.send_topics()
            self.status()
        elif cmd == "resume":
            self.paused = False
            self._anchor()
            self.status()
        elif cmd == "step":
            self.paused = True
            if self.sim.time <= self.stop_time:
                self.tick()
            self.flush()
            self.send_topics()
            self.status()
        elif cmd == "stop":
            self.running = False
        elif cmd == "speed":
            self.realtime = bool(msg.get("realtime", self.realtime))
            self.speed = float(msg.get("speed", self.speed)) or 1.0
            self._anchor()
        elif cmd in ("monitor", "unmonitor"):
            self.monitor(msg["endpoint"], cmd == "monitor")

    def tick(self) -> None:
        self.sim.step()

    def loop(self) -> None:
        self.emit({"type": "started", "dt": self.sim.dt, "stop_time": self.stop_time,
                   "aliases": self.aliases, "scopes": self.scopes})
        self.status()
        last_flush = last_topics = time.monotonic()
        while self.running:
            try:
                timeout = 0.1 if self.paused else None
                while True:
                    msg = self.cmd_q.get(timeout=timeout) if timeout else self.cmd_q.get_nowait()
                    self.handle(msg)
                    timeout = None
            except queue.Empty:
                pass
            if not self.running:
                break
            if self.paused:
                continue
            if self.sim.time > self.stop_time:
                break
            if self.realtime:
                ahead = self.wall0 + (self.sim.time - self.sim0) / self.speed - time.monotonic()
                if ahead > 0:
                    time.sleep(min(ahead, 0.02))
                    continue
            self.tick()
            now = time.monotonic()
            if now - last_flush >= FLUSH_INTERVAL:
                self.flush()
                last_flush = now
            if now - last_topics >= TOPICS_INTERVAL:
                self.send_topics()
                last_topics = now
        self.flush()
        self.send_topics()
        self.emit({"type": "done", "t": self.sim.time})


def worker_main(diagram: dict, monitors: Iterable[str], cmd_q: Any, evt_q: Any) -> None:
    """Entry point of the worker process."""
    emit = evt_q.put
    try:
        doc = validate_diagram(diagram)
        sim = Simulation(build_system(doc["root"]), base_step=doc["sim"]["base_step"])
    except DiagramError as exc:
        emit({"type": "error", "phase": "build", "message": exc.message, "path": exc.path})
        return
    except AlgebraicLoopError as exc:
        emit({"type": "error", "phase": "build", "message": str(exc),
              "path": exc.paths[0] if exc.paths else None, "paths": exc.paths})
        return
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "phase": "build", "message": f"{type(exc).__name__}: {exc}",
              "path": None})
        return
    worker = _Worker(sim, doc["sim"], cmd_q, emit)
    for endpoint in monitors:
        worker.monitor(endpoint, True)
    try:
        worker.loop()
    except CallbackError as exc:
        worker.flush()
        worker.send_topics()
        emit({"type": "error", "phase": "run", "message": str(exc.original) or type(exc.original).__name__,
              "path": exc.path, "t": exc.t, "traceback": exc.traceback})


class SimProcess:
    """Handle to a simulation running in a child process."""

    def __init__(self, diagram: dict, monitors: Iterable[str] = ()) -> None:
        ctx = mp.get_context("spawn")
        self._cmd_q = ctx.Queue()
        self._evt_q = ctx.Queue()
        self._proc = ctx.Process(target=worker_main, daemon=True,
                                 args=(diagram, list(monitors), self._cmd_q, self._evt_q))

    def start(self) -> None:
        """Start the worker process."""
        self._proc.start()

    def send(self, msg: dict) -> None:
        """Send a command to the worker."""
        self._cmd_q.put(msg)

    def get_event(self, timeout: float | None = None) -> dict | None:
        """Return the next event, or None on timeout."""
        try:
            return self._evt_q.get(timeout=timeout)
        except queue.Empty:
            return None

    @property
    def alive(self) -> bool:
        """True while the worker process is running."""
        return self._proc.is_alive()

    def stop(self, timeout: float = 1.0) -> bool:
        """Ask the worker to stop; kill it after ``timeout`` s.

        Returns True if the worker had to be terminated (e.g. a callback
        stuck in an infinite loop).
        """
        if not self._proc.is_alive():
            return False
        self.send({"cmd": "stop"})
        self._proc.join(timeout)
        if self._proc.is_alive():
            self._proc.terminate()
            self._proc.join(1.0)
            return True
        return False
