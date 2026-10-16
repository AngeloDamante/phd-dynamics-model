"""Static checks of callback source, without executing it."""

from __future__ import annotations

import ast


def check_callback_source(source: str) -> list[dict]:
    """Return problems in ``source`` as ``{line, column, message}`` dicts.

    Only parses the code (``ast``), so it is safe to run on untrusted input.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [{"line": exc.lineno or 1, "column": exc.offset or 1, "message": exc.msg}]
    steps = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "step"]
    if not steps:
        return [{"line": 1, "column": 1,
                 "message": "define a function step(t, inp, out, p, state)"}]
    args = steps[-1].args
    positional = len(args.posonlyargs) + len(args.args)
    if args.vararg is None and positional - len(args.defaults) > 5 or \
            args.vararg is None and positional < 5:
        fn = steps[-1]
        return [{"line": fn.lineno, "column": fn.col_offset + 1,
                 "message": "step must accept (t, inp, out, p, state)"}]
    return []
