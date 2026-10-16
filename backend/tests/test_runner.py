import time

from conftest import block, diagram, wire

from simnode.runner import SimProcess, numeric_components


def collect(proc, until_type, timeout=10.0):
    events = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ev = proc.get_event(0.1)
        if ev is None:
            continue
        events.append(ev)
        if ev["type"] in until_type:
            return events
    raise AssertionError(f"timed out waiting for {until_type}: {[e['type'] for e in events]}")


def series(events, key):
    ts, vs = [], []
    for ev in events:
        if ev["type"] == "data" and key in ev["series"]:
            ts += ev["series"][key][0]
            vs += ev["series"][key][1]
    return ts, vs


def test_numeric_components():
    assert numeric_components(1.5) == [("", 1.5)]
    assert numeric_components([1, 2]) == [("[0]", 1.0), ("[1]", 2.0)]
    assert numeric_components({"x": 1, "v": [True]}) == [(".x", 1.0), (".v[0]", 1.0)]
    assert numeric_components(float("nan")) == [("", None)]
    assert numeric_components("text") == []


def test_runs_to_completion_and_streams_scope(gain_loop_diagram):
    proc = SimProcess(gain_loop_diagram)
    proc.start()
    events = collect(proc, {"done", "error"})
    types = [e["type"] for e in events]
    assert types[0] == "started" and types[-1] == "done"
    started = events[0]
    assert started["scopes"] == {"scope": ["sub/g.y"]}
    assert started["aliases"]["sub.y"] == "sub/g.y"
    ts, vs = series(events, "sub/g.y")
    assert len(ts) == 11 and set(vs) == {6.0}
    topics = [e for e in events if e["type"] == "topics"][-1]["topics"]
    assert topics["c.y"]["count"] == 11
    proc.stop()


def test_build_error_reports_path():
    bad = block("oops", "PythonNode", code="def step(t):\n    pass\n")
    proc = SimProcess(diagram([bad], [], base_step=0.1))
    proc.start()
    ev = collect(proc, {"error"})[-1]
    assert ev["phase"] == "build" and ev["path"] == "oops"


def test_callback_error_reports_path_and_time():
    code = "def step(t, inp, out, p, state):\n    if t > 0.25:\n        1 / 0\n"
    node = block("boom", "PythonNode", code=code, sample_time=0.1)
    proc = SimProcess(diagram([node], []))
    proc.start()
    ev = collect(proc, {"error", "done"})[-1]
    assert ev["type"] == "error" and ev["phase"] == "run"
    assert ev["path"] == "boom" and abs(ev["t"] - 0.3) < 1e-9
    assert "ZeroDivisionError" in ev["traceback"]


def test_infinite_loop_is_killed_on_stop():
    code = "def step(t, inp, out, p, state):\n    while True:\n        pass\n"
    node = block("spin", "PythonNode", code=code, sample_time=0.1)
    proc = SimProcess(diagram([node], []))
    proc.start()
    collect(proc, {"started"})
    assert proc.stop(timeout=0.3) is True
    assert not proc.alive


def test_pause_step_and_probe(gain_loop_diagram):
    gain_loop_diagram["sim"].update(start_paused=True, stop_time=100.0)
    proc = SimProcess(gain_loop_diagram, monitors=["sub/u.y"])  # probe via Inport alias
    proc.start()
    collect(proc, {"status"})
    proc.send({"cmd": "step"})
    proc.send({"cmd": "step"})
    events = collect(proc, {"status"}) + collect(proc, {"status"})
    assert series(events, "c.y") == ([0.0, 0.1], [2.0, 2.0])
    proc.stop()


def test_realtime_pacing():
    c = block("c", "Constant", value=1.0, sample_time=0.05)
    proc = SimProcess(diagram([c], [], stop_time=0.5, realtime=True, speed=1.0))
    start = time.monotonic()
    proc.start()
    collect(proc, {"done"})
    assert time.monotonic() - start >= 0.45
