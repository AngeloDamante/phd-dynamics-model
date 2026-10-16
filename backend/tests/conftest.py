import itertools

import pytest

_ids = itertools.count()


def block(name, type_, x=0, y=0, **params):
    """Diagram block dict with a fresh id."""
    return {"id": f"b{next(_ids)}", "name": name, "type": type_, "params": params,
            "x": x, "y": y}


def wire(src_block, src_port, dst_block, dst_port):
    return {"id": f"w{next(_ids)}", "src": {"block": src_block["id"], "port": src_port},
            "dst": {"block": dst_block["id"], "port": dst_port}}


def diagram(blocks, wires, **sim):
    return {"format": "simnode-diagram", "version": 1, "name": "test",
            "sim": {"stop_time": 1.0, **sim}, "root": {"blocks": blocks, "wires": wires}}


@pytest.fixture
def gain_loop_diagram():
    """Constant -> subsystem(Gain x3) -> Scope, as a diagram document."""
    inner_in = block("u", "Inport")
    inner_g = block("g", "Gain", k=3.0)
    inner_out = block("y", "Outport")
    sub = block("sub", "Subsystem")
    sub["system"] = {"blocks": [inner_in, inner_g, inner_out],
                     "wires": [wire(inner_in, "y", inner_g, "u"),
                               wire(inner_g, "y", inner_out, "u")]}
    c = block("c", "Constant", value=2.0, sample_time=0.1)
    scope = block("scope", "Scope", n_inputs=1)
    return diagram([c, sub, scope], [wire(c, "y", sub, "u"), wire(sub, "y", scope, "in1")])
