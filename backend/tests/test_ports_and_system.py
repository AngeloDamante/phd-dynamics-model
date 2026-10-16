import pytest

from simnode.core import Node, OnMessage, PortError, PortSpec, System


def test_port_names_must_be_identifiers():
    with pytest.raises(PortError):
        PortSpec("not valid")
    with pytest.raises(PortError):
        PortSpec("fresh")
    with pytest.raises(PortError):
        PortSpec("class")


def test_duplicate_ports_rejected():
    with pytest.raises(PortError):
        Node("n", inputs=["a", "a"])


def test_trigger_ports_must_exist():
    with pytest.raises(PortError):
        Node("n", inputs=["a"], trigger=OnMessage(("b",)))


def test_connect_validates_ports_and_single_driver():
    s = System()
    s.add(Node("a", outputs=["y"]))
    s.add(Node("b", outputs=["y"]))
    s.add(Node("c", inputs=["u"]))
    with pytest.raises(PortError):
        s.connect("a.nope", "c.u")
    with pytest.raises(PortError):
        s.connect("a.y", "c.nope")
    s.connect("a.y", "c.u")
    with pytest.raises(PortError, match="already connected"):
        s.connect("b.y", "c.u")
    s.disconnect("c.u")
    s.connect("b.y", "c.u")
    assert str(s.driver("c.u")) == "b.y"


def test_connect_checks_dtypes():
    s = System()
    s.add(Node("a", outputs=[PortSpec("y", "Float64")]))
    s.add(Node("b", inputs=[PortSpec("u", "Twist")]))
    s.add(Node("c", inputs=["u"]))
    with pytest.raises(PortError, match="type mismatch"):
        s.connect("a.y", "b.u")
    s.connect("a.y", "c.u")  # untyped input accepts anything


def test_remove_drops_wires():
    s = System()
    s.add(Node("a", outputs=["y"]))
    s.add(Node("b", inputs=["u"]))
    s.connect("a.y", "b.u")
    s.remove("a")
    assert s.wires == []
