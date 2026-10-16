import pytest

from simnode.blocks import Constant, Gain
from simnode.core import (AlgebraicLoopError, Inport, Outport, Recorder,
                          Simulation, Subsystem, System, flatten)


def gain_subsystem(name, k):
    inner = System()
    inner.add(Inport("u"))
    inner.add(Gain("g", k))
    inner.add(Outport("y"))
    inner.connect("u.y", "g.u")
    inner.connect("g.y", "y.u")
    return Subsystem(name, inner)


def test_subsystem_ports_come_from_boundary_blocks():
    sub = gain_subsystem("s", 2.0)
    assert [p.name for p in sub.inputs] == ["u"]
    assert [p.name for p in sub.outputs] == ["y"]


def test_nested_subsystems_flatten_and_simulate():
    outer_inner = System()
    outer_inner.add(Inport("x"))
    outer_inner.add(gain_subsystem("s1", 2.0))
    outer_inner.add(gain_subsystem("s2", 5.0))
    outer_inner.add(Outport("z"))
    outer_inner.connect("x.y", "s1.u")
    outer_inner.connect("s1.y", "s2.u")
    outer_inner.connect("s2.y", "z.u")

    top = System()
    top.add(Constant("c", 1.5, 0.1))
    top.add(Subsystem("outer", outer_inner))
    top.add(Gain("tap", 1.0))
    top.connect("c.y", "outer.x")
    top.connect("outer.z", "tap.u")

    flat = flatten(top)
    assert set(flat.leaves) == {"c", "outer/s1/g", "outer/s2/g", "tap"}
    assert flat.drivers[("outer/s1/g", "u")] == ("c", "y")
    assert flat.drivers[("tap", "u")] == ("outer/s2/g", "y")

    sim = Simulation(top)
    sim.step()
    assert sim.value("tap", "y") == pytest.approx(15.0)


def test_fan_out_from_subsystem_output():
    top = System()
    top.add(Constant("c", 1.0, 0.1))
    top.add(gain_subsystem("s", 3.0))
    top.add(Gain("a", 1.0))
    top.add(Gain("b", -1.0))
    top.connect("c.y", "s.u")
    top.connect("s.y", "a.u")
    top.connect("s.y", "b.u")
    sim = Simulation(top)
    sim.step()
    assert (sim.value("a", "y"), sim.value("b", "y")) == (3.0, -3.0)


def test_unconnected_subsystem_input_uses_default():
    inner = System()
    inner.add(Inport("u", default=7.0))
    inner.add(Outport("y"))
    inner.connect("u.y", "y.u")
    top = System()
    top.add(Subsystem("s", inner))
    assert flatten(top).drivers == {}


def test_pure_wire_loop_through_subsystem_rejected():
    top = System()
    inner = System()
    inner.add(Inport("u"))
    inner.add(Outport("y"))
    inner.connect("u.y", "y.u")
    top.add(Subsystem("s", inner))
    top.add(Gain("g"))
    top.connect("s.y", "s.u")
    top.connect("s.y", "g.u")
    with pytest.raises(AlgebraicLoopError):
        flatten(top)
