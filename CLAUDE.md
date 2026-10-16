# Project: Simulink-style Web Simulator for ROS-like Dynamic Nodes

## Vision

A web app that recreates the core Simulink workflow — drag-and-drop
blocks, wires between ports, nested subsystems, scopes — where each block
behaves like a ROS node: named input/output topics, a Python callback that
fires either on a fixed sample time or when new data arrives on a
subscribed topic, and per-node parameters. Purpose: prototype and test the
behaviour of ROS nodes before implementing them for real.

## Core concepts

- **Node** — atomic simulation unit. Declares input ports (subscribers),
  output ports (publishers), parameters, and a user-written Python callback.
- **Port** — named input/output slot; payload is any Python value, with an
  optional declared type (e.g. `Float64`, `Vector3`) checked on connect.
- **Wire / Topic** — connects one output port to one or more input ports.
- **Trigger mode per node**:
  - *periodic*: callback fires every `sample_time` seconds of sim time;
  - *on-message*: callback fires when new data arrives on selected inputs
    (or any input).
- **System** — graph of nodes and wires.
- **Subsystem** — a System wrapped as a node. Its boundary ports are
  `Inport`/`Outport` blocks inside it (Simulink-style).
- **Scheduler** — discrete-time clock with base step = GCD of sample times.
  Each tick: periodic nodes fire in topological order; every publish
  triggers on-message subscribers within the same tick (micro-steps). A
  zero-delay cycle is an algebraic loop error — break it with `UnitDelay`.
  Runs as-fast-as-possible or real-time with a scale factor.

## Callback contract

```python
def step(t, inp, out, p, state):
    out.u = p.kp * (inp.ref - inp.y)
```
- `t` sim time, `inp` latest values on input ports, `out` assign to publish,
  `p` parameters (read-only), `state` per-node persistent dict.
- Only assigned outputs are published in that call.

## Monitoring

- **Scope block**: N inputs, floating live-plot window (uPlot), pause/zoom,
  CSV export.
- **Wire probe**: right-click a wire → "Monitor" → signal shows in the
  Data Inspector panel, no block needed.
- **Topic hover**: last value + publish rate (like `rostopic echo/hz`).

## Architecture

- `backend/simnode/core/` — GUI-agnostic engine, zero web/GUI imports:
  ports, node, system/subsystem (flattening), scheduler.
- `backend/simnode/blocks/` — standard library (Constant, Step, Sine, Gain,
  Sum, UnitDelay, Scope, Inport, Outport, ...), registered via `registry.py`.
- `backend/simnode/io/` — diagram (de)serialization, versioned JSON schema.
- `backend/simnode/api/` — FastAPI: REST for diagram editing, WebSocket for
  sim control + data streaming. User callbacks execute in a separate
  worker process so crashes/infinite loops don't kill the server.
- `backend/tests/` — pytest, headless.
- `frontend/` — TypeScript + Vite + JointJS (orthogonal/manhattan routing,
  `jumpover` connector for line hops at wire crossings), Monaco editor for
  callbacks, uPlot for scopes.

## Decisions (settled 2026-10-16)

- Web app, not PySide6.
- Discrete-time only for now; plants are integrated inside callbacks
  (Euler/RK4 with `dt`). Continuous blocks/ODE solver maybe later.
- Dynamic payloads with optional port types.
- Simulated pub/sub only. ROS2 bridge / rclpy node generation later, behind
  an isolated interface.

## Environment notes

- System Python is 3.10 — code must stay 3.10-compatible.
- Frontend needs Node >= 18 (system has Node 12; use nvm).

## Coding conventions

- PEP8 + type hints everywhere; docstrings on public classes/methods.
- Callbacks are pure w.r.t. declared ports: read inputs, write outputs,
  persistent data only via `state`.
- `core/` stays dependency-light and headless-testable.
- New block types go under `blocks/` and are registered, never hardcoded
  into the frontend.
- Small, reviewable increments, each with tests.

## Working agreement

- Ask before adding a new third-party dependency.
- Run the test suite before and after any change to `core/`.
