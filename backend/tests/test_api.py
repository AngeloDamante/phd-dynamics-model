import pytest
from fastapi.testclient import TestClient

from simnode.api import create_app
from simnode.io import empty_diagram


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(tmp_path))


def test_block_palette(client):
    blocks = {b["type"]: b for b in client.get("/api/blocks").json()}
    assert blocks["Sum"]["params"] == {"signs": "++"}
    assert [p["name"] for p in blocks["Sum"]["inputs"]] == ["in1", "in2"]
    assert "system" not in blocks["Subsystem"]["params"]


def test_ports_endpoint(client):
    r = client.post("/api/blocks/ports", json={"type": "Sum", "params": {"signs": "+-+"}})
    assert [p["name"] for p in r.json()["inputs"]] == ["in1", "in2", "in3"]
    r = client.post("/api/blocks/ports", json={"type": "PythonNode", "params": {
        "code": "this is not python", "inputs": [{"name": "a", "dtype": "Float64"}]}})
    assert r.json()["inputs"] == [{"name": "a", "dtype": "Float64"}]
    r = client.post("/api/blocks/ports", json={"type": "Sum", "params": {"signs": "*"}})
    assert r.status_code == 400


def test_diagram_crud(client):
    assert client.get("/api/diagrams").json() == []
    assert client.put("/api/diagrams/demo", json=empty_diagram()).status_code == 200
    assert client.get("/api/diagrams").json() == ["demo"]
    assert client.get("/api/diagrams/demo").json()["name"] == "demo"
    assert client.put("/api/diagrams/demo", json={"format": "x"}).status_code == 422
    assert client.get("/api/diagrams/..%2Fetc").status_code in (400, 404)
    assert client.delete("/api/diagrams/demo").status_code == 200
    assert client.get("/api/diagrams/demo").status_code == 404


def test_websocket_simulation(client, gain_loop_diagram):
    with client.websocket_connect("/api/sim") as ws:
        ws.send_json({"cmd": "start", "diagram": gain_loop_diagram})
        types = []
        while not types or types[-1] not in ("done", "error"):
            types.append(ws.receive_json()["type"])
        assert types[0] == "started" and types[-1] == "done"
        assert "data" in types
        ws.send_json({"cmd": "stop"})
        assert ws.receive_json() == {"type": "stopped", "killed": False}


def test_code_check_is_static(client):
    ok = "def step(t, inp, out, p, state):\n    out.y = 1\n"
    assert client.post("/api/code/check", json={"code": ok}).json() == {"problems": []}
    bad = client.post("/api/code/check", json={"code": "def step(t:\n"}).json()["problems"]
    assert bad[0]["line"] == 1
    # Never executed: an import side effect would be harmless here anyway.
    sig = client.post("/api/code/check",
                      json={"code": "import os\ndef step(t):\n    pass\n"}).json()["problems"]
    assert "accept" in sig[0]["message"] and sig[0]["line"] == 2
