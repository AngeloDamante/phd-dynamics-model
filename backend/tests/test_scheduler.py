import pytest

from simnode.core import (AlgebraicLoopError, CallbackError, Node, OnMessage,
                          Periodic, Recorder, Simulation, System)
from simnode.blocks import Constant, Gain, Sum, UnitDelay


def counter(name, ts):
    def step(t, inp, out, p, state):
        state.n = state.get("n", 0) + 1
        out.y = state.n
    return Node(name, outputs=["y"], trigger=Periodic(ts), step=step)


def test_base_step_is_gcd_of_sample_times():
    s = System()
    s.add(counter("a", 0.1))
    s.add(counter("b", 0.25))
    sim = Simulation(s)
    assert sim.dt == pytest.approx(0.05)
    sim.run(until=1.0)
    assert sim.value("a", "y") == 11  # t = 0, 0.1, ..., 1.0
    assert sim.value("b", "y") == 5   # t = 0, 0.25, ..., 1.0


def test_no_periodic_node_needs_base_step():
    s = System()
    s.add(Gain("g"))
    with pytest.raises(ValueError):
        Simulation(s)
    Simulation(s, base_step=0.1)


def test_downstream_sees_same_tick_value_regardless_of_insertion_order():
    s = System()
    s.add(Gain("g", k=2.0))  # added before its source
    s.add(Constant("c", value=3.0, sample_time=0.1))
    s.connect("c.y", "g.u")
    rec = Recorder()
    sim = Simulation(s)
    sim.add_listener(rec)
    sim.step()
    assert rec.samples[("g", "y")] == [(0.0, 6.0)]
    assert sim.order == ["c", "g"]


def test_on_message_fires_once_per_tick_with_multiple_inputs():
    s = System()
    s.add(Constant("a", 1.0, 0.1))
    s.add(Constant("b", 2.0, 0.1))
    s.add(Sum("sum", "+-"))
    s.connect("a.y", "sum.in1")
    s.connect("b.y", "sum.in2")
    rec = Recorder([("sum", "y")])
    sim = Simulation(s)
    sim.add_listener(rec)
    sim.run(until=0.25)
    assert rec.series("sum", "y") == ([0.0, 0.1, 0.2], [-1.0, -1.0, -1.0])


def test_trigger_ports_filter():
    calls = []

    def step(t, inp, out, p, state):
        calls.append((inp.a, inp.b, inp.fresh("a"), inp.fresh("b")))

    s = System()
    s.add(Constant("ca", 1.0, 0.1))
    s.add(Constant("cb", 2.0, 0.05))
    s.add(Node("n", inputs=["a", "b"], trigger=OnMessage(("a",)), step=step))
    s.connect("ca.y", "n.a")
    s.connect("cb.y", "n.b")
    sim = Simulation(s)
    sim.run(until=0.1)
    # Ticks at 0, .05, .1: only ticks where "a" publishes fire the node.
    assert calls == [(1.0, 2.0, True, True), (1.0, 2.0, True, True)]


def test_algebraic_loop_detected():
    s = System()
    s.add(Constant("c", 1.0, 0.1))
    s.add(Sum("sum", "++"))
    s.add(Gain("g", 0.5))
    s.connect("c.y", "sum.in1")
    s.connect("sum.y", "g.u")
    s.connect("g.y", "sum.in2")
    with pytest.raises(AlgebraicLoopError):
        Simulation(s)


def test_unit_delay_breaks_loop_as_accumulator():
    # y[k] = 1 + y[k-1]  ->  1, 2, 3, ...
    s = System()
    s.add(Constant("c", 1.0, 0.1))
    s.add(Sum("sum", "++"))
    s.add(UnitDelay("z", initial=0.0, sample_time=0.1))
    s.connect("c.y", "sum.in1")
    s.connect("sum.y", "z.u")
    s.connect("z.y", "sum.in2")
    rec = Recorder([("sum", "y")])
    sim = Simulation(s)
    sim.add_listener(rec)
    sim.run(until=0.4)
    assert rec.series("sum", "y")[1] == [1.0, 2.0, 3.0, 4.0, 5.0]


def test_callback_error_carries_node_path():
    def boom(t, inp, out, p, state):
        raise ZeroDivisionError("nope")

    s = System()
    s.add(Node("bad", trigger=Periodic(0.1), step=boom))
    sim = Simulation(s)
    with pytest.raises(CallbackError) as err:
        sim.step()
    assert err.value.path == "bad"
    assert "ZeroDivisionError" in err.value.traceback


def test_unknown_output_assignment_fails():
    def step(t, inp, out, p, state):
        out.typo = 1

    s = System()
    s.add(Node("n", outputs=["y"], trigger=Periodic(0.1), step=step))
    with pytest.raises(CallbackError, match="typo"):
        Simulation(s).step()


def test_reset_restores_initial_state():
    s = System()
    s.add(counter("a", 0.1))
    sim = Simulation(s)
    sim.run(until=0.3)
    sim.reset()
    assert sim.time == 0.0 and sim.value("a", "y") is None
    sim.step()
    assert sim.value("a", "y") == 1
