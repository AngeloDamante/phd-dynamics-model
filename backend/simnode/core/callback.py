"""Compile user-written Python callback source into a step function."""

from __future__ import annotations

import inspect
import math

from .node import StepFn

#: Modules pre-imported in every callback's namespace.
CALLBACK_GLOBALS = {"math": math}


class CallbackCompileError(ValueError):
    """The callback source is invalid or defines no usable ``step``."""


def compile_step(source: str, filename: str = "<node>") -> StepFn:
    """Execute ``source`` and return the ``step(t, inp, out, p, state)`` it defines.

    The source runs in a fresh namespace, so helper functions and imports
    defined next to ``step`` are available to it. This executes arbitrary
    code: only run diagrams you trust.
    """
    namespace: dict = dict(CALLBACK_GLOBALS)
    try:
        exec(compile(source, filename, "exec"), namespace)
    except SyntaxError as exc:
        raise CallbackCompileError(f"{filename}:{exc.lineno}: {exc.msg}") from exc
    except Exception as exc:  # noqa: BLE001 - module-level code may raise anything
        raise CallbackCompileError(f"{filename}: {type(exc).__name__}: {exc}") from exc
    fn = namespace.get("step")
    if not callable(fn):
        raise CallbackCompileError(f"{filename}: source must define a function 'step'")
    try:
        inspect.signature(fn).bind(0.0, None, None, None, None)
    except TypeError:
        raise CallbackCompileError(
            f"{filename}: step must accept (t, inp, out, p, state)") from None
    return fn
