# phd-dynamics-model — simnode

A Simulink-style web simulator for ROS-like nodes: drag blocks onto a canvas,
wire publishers to subscribers, write node callbacks in Python, group nodes
into subsystems and watch signals on scopes. ROS is the mental model only
(nodes, topics, timer vs subscriber callbacks): nothing here talks to a real
ROS graph.

## Setup

Requires Python >= 3.10 and Node >= 18.

```bash
python3 -m venv .venv
.venv/bin/pip install -e 'backend[dev]'
cd frontend && npm install && npm run build
```

## Run

```bash
.venv/bin/python -m simnode.api --diagrams diagrams   # http://127.0.0.1:8000
```

Options: `--host` (default `127.0.0.1`), `--port` (default `8000`),
`--diagrams` (folder where diagrams are saved as JSON).

For frontend development, run the backend as above and `npm run dev` in
`frontend/` (Vite on :5173 with hot reload, proxying `/api` to :8000).

> Diagrams contain Python that runs on this machine. The server binds to
> localhost by default — only open diagrams you trust.

## Quick start

Open `pid_demo` (toolbar → *Open…*) and press **F5**: a PI controller drives
a mass-spring-damper plant (inside the `plant` subsystem); the Scope and the
Data Inspector show reference, output and control effort.

## Building a diagram

### 1. Add blocks

Drag a block from the palette on the left onto the canvas (or double-click
it in the palette to drop it in the middle of the view). Categories:

| Category | Blocks |
|---|---|
| Sources | Constant, Step, Sine |
| Math | Gain, Sum (signs like `+-`) |
| Discrete | UnitDelay (`1/z`, breaks feedback loops) |
| Sinks | Scope (N inputs) |
| Ports & Subsystems | Inport, Outport, Subsystem |
| User-Defined | PythonNode |

Select a block to edit its name and parameters in the inspector on the right.

### 2. Wire them

Drag from an output port (▷ on the right side of a block) to an input port
(▷ on the left side). A wire is a **topic**: one output can feed many inputs,
an input has exactly one driver. If both ports declare a type (e.g.
`Float64`), they must match. Wires are routed orthogonally and hop over each
other at crossings; drag a segment to move it, right-click → *Reset route* to
re-route.

### 3. Create a node (PythonNode)

A PythonNode is the equivalent of a ROS node. In the inspector:

- **Trigger**
  - *Periodic (timer)* — the callback fires every **Ts** seconds of
    simulated time (badge `Ts=…` on the block);
  - *On message (subscriber)* — the callback fires when new data arrives on
    the checked inputs (all inputs if none is checked; badge `⚡msg`).
    New nodes start in this mode.
- **Direct feedthrough** — keep it checked if the outputs depend on the
  inputs of the same tick (controllers, filters). Uncheck it when the
  outputs depend only on the state (plants integrated with Euler/RK4): the
  node then runs first and sees the previous tick's inputs, which breaks
  feedback loops.
- **Inputs (subscribers) / Outputs (publishers)** — port names (valid Python
  identifiers) and optional type.
- **Parameters** — name/value pairs, read in the callback as `p.<name>`.
- **Edit callback code…** — opens the code editor (autocomplete for `inp.`,
  `out.`, `p.`). The code is checked while you type (syntax, `step`
  signature); it is never executed until the simulation runs.

The callback contract:

```python
def step(t, inp, out, p, state):
    e = inp.ref - inp.y                  # latest message on each input
    state.i = state.get("i", 0.0) + e * p.Ts
    out.u = p.kp * e + p.ki * state.i    # assigning publishes
```

| Name | Meaning |
|---|---|
| `t` | simulated time [s] |
| `inp.<name>` | latest value on an input (the port default until the first message) |
| `inp.fresh(name)` | `True` if a new message arrived since the last call |
| `out.<name> = v` | publish `v`; outputs not assigned in a call are not published |
| `p.<name>` | parameters (read-only) |
| `state` | dict kept between calls (`state.x` or `state["x"]`) |

Values can be any Python object; numbers, lists and dicts of numbers can be
plotted (one trace per component).

Several periodic nodes may have different periods (e.g. controller at
10 ms, plant at 1 ms): the simulation base step is the GCD of all sample
times, unless set explicitly in the toolbar.

### 4. Subsystems

Select some blocks and press **Ctrl+G**: they move into a Subsystem, with
Inport/Outport blocks created for every wire crossing the selection.
Double-click a subsystem to enter it, use the breadcrumb at the top (or
**Esc**) to go back. You can also create an empty Subsystem from the palette
and add Inport/Outport blocks inside: they become its ports.

### 5. Simulate

Toolbar: **stop time**, **base step** (empty = automatic), **Real time** with
a speed factor (otherwise as fast as possible), and ▶ Run / ⏸ Pause /
⏭ Step / ■ Stop.

Errors in a callback stop the run, highlight the block in red and show the
traceback in the *Log* tab (*Show block* jumps to it). A feedback loop with no
delay is reported as an algebraic loop: insert a UnitDelay or uncheck *Direct
feedthrough* on one of the nodes.

### 6. Monitor signals

- **Scope** — double-click it (or *Open scope* in the inspector) to open a
  floating live plot of its inputs.
- **Wire probe** — right-click a wire → *Monitor in Data Inspector*: the
  signal is plotted in the bottom panel, no block needed.
- **Topic hover** — hover a wire to see its last value, publish rate and
  message count (like `rostopic echo` / `rostopic hz`).

Plots: drag to zoom, double-click or *Fit* to autoscale, *Freeze* to stop
the display while the simulation runs, *Stairs* for zero-order-hold drawing,
*CSV* to export.

### 7. Save

**Ctrl+S** (or *Save* / *Save as…*) writes the diagram to
`diagrams/<name>.json`. The last opened diagram is reopened at startup; the
browser warns before closing with unsaved changes.

## Editor shortcuts

| | |
|---|---|
| Drag ▷ out → ▷ in | connect |
| Drag on empty canvas | rubber-band select |
| Double-click | open subsystem / edit code / open scope |
| Right-click | context menu (block, wire, canvas) |
| Ctrl+G | group selection into a subsystem |
| Ctrl+Z / Ctrl+Y | undo / redo |
| Ctrl+C / Ctrl+V, Del | copy / paste, delete |
| Ctrl+A | select all |
| Ctrl+S | save |
| Esc | leave subsystem |
| F5 / Shift+F5 / F6 / F10 | run / stop / pause / step |
| Ctrl+wheel | zoom |

## Tests

```bash
cd backend && ../.venv/bin/python -m pytest -q
cd frontend && npm run typecheck
```
