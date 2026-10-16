import pytest
from conftest import block, diagram, wire

from simnode.core import Simulation, flatten
from simnode.io import DiagramError, build_system, empty_diagram, validate_diagram


def test_empty_diagram_round_trip():
    doc = validate_diagram(empty_diagram("x"))
    assert doc["sim"]["stop_time"] == 10.0
    assert doc["root"] == {"blocks": [], "wires": []}


def test_rejects_wrong_format_and_future_version():
    with pytest.raises(DiagramError):
        validate_diagram({"format": "nope"})
    with pytest.raises(DiagramError, match="newer"):
        validate_diagram({**empty_diagram(), "version": 99})


def test_rejects_dangling_wire():
    a = block("a", "Constant")
    doc = diagram([a], [{"id": "w", "src": {"block": a["id"], "port": "y"},
                         "dst": {"block": "missing", "port": "u"}}])
    with pytest.raises(DiagramError, match="invalid dst"):
        validate_diagram(doc)


def test_build_nested_system_and_simulate(gain_loop_diagram):
    doc = validate_diagram(gain_loop_diagram)
    system = build_system(doc["root"])
    sim = Simulation(system)
    sim.step()
    assert sim.input_value("scope", "in1") == 6.0
    aliases = flatten(system).output_aliases()
    assert aliases[("sub", "y")] == ("sub/g", "y")
    assert aliases[("sub/u", "y")] == ("c", "y")


def test_build_errors_carry_block_path():
    bad = block("bad", "Gain", nope=1)
    with pytest.raises(DiagramError) as err:
        build_system(diagram([bad], [])["root"])
    assert err.value.path == "bad"


def test_python_node_ports_from_dicts():
    code = "def step(t, inp, out, p, state):\n    out.y = inp.u * p.k\n"
    src = block("c", "Constant", value=2.0, sample_time=0.5)
    py = block("py", "PythonNode", code=code, inputs=[{"name": "u", "dtype": None}],
               outputs=[{"name": "y"}], params={"k": 10})
    sim = Simulation(build_system(diagram([src, py], [wire(src, "y", py, "u")])["root"]))
    sim.step()
    assert sim.value("py", "y") == 20
