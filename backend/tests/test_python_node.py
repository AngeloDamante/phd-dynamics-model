import pytest

from simnode import registry
from simnode.blocks import PythonNode, Step
from simnode.core import CallbackCompileError, Recorder, Simulation, System

PI = '''
def step(t, inp, out, p, state):
    e = inp.ref - inp.y
    state.i = state.get("i", 0.0) + e * p.dt
    out.u = p.kp * e + p.ki * state.i
'''

PLANT = '''
def step(t, inp, out, p, state):
    # first-order plant  tau*dx/dt = -x + u, explicit Euler
    x = state.get("x", 0.0)
    u = inp.u if inp.received("u") else 0.0
    state.x = x + p.dt / p.tau * (-x + u)
    out.y = x
'''


def test_compile_errors():
    with pytest.raises(CallbackCompileError, match="define a function 'step'"):
        PythonNode("n", code="x = 1")
    with pytest.raises(CallbackCompileError, match=":2:"):
        PythonNode("n", code="def step(t, inp, out, p, state):\nreturn")
    with pytest.raises(CallbackCompileError, match="accept"):
        PythonNode("n", code="def step(t):\n    pass")


def test_registry_lists_and_creates():
    types = registry.block_types()
    assert types["Gain"].category == "Math"
    node = registry.create("Gain", "g", k=4.0)
    assert node.params["k"] == 4.0
    with pytest.raises(KeyError):
        registry.create("Nope", "x")


def test_closed_loop_pi_tracks_step():
    dt = 0.01
    s = System()
    s.add(Step("ref", step_time=0.1, final=1.0, sample_time=dt))
    # Periodic PI controller and plant, like two ROS nodes on timers.
    s.add(PythonNode("pi", PI, inputs=["ref", "y"], outputs=["u"],
                     params={"kp": 2.0, "ki": 5.0, "dt": dt}, sample_time=dt))
    s.add(PythonNode("plant", PLANT, inputs=["u"], outputs=["y"],
                     params={"tau": 0.5, "dt": dt}, sample_time=dt,
                     direct_feedthrough=False))
    s.connect("ref.y", "pi.ref")
    s.connect("plant.y", "pi.y")
    s.connect("pi.u", "plant.u")
    rec = Recorder([("plant", "y")])
    sim = Simulation(s)
    sim.add_listener(rec)
    sim.run(until=5.0)
    _, y = rec.series("plant", "y")
    assert y[0] == 0.0
    assert y[-1] == pytest.approx(1.0, abs=1e-3)
