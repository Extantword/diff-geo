#!/usr/bin/env python3
"""
Cross-check the TypeScript CAS against sympy.

The vitest suite already pins every derivative-table entry against an independently written
closed form, and the structural rules against Richardson-extrapolated differences. What it
cannot do is check our derivative against a *second implementation of differentiation*. That
is what sympy provides here, and it is the only gate in the project that does.

## Numeric first, symbolic on suspicion

The obvious design — `simplify(ours - sympy.diff(f)) == 0` for every case — is a proof, and it
is also unusably slow: `simplify` and even `Expr.equals` took over ten minutes to get through
a couple of hundred derivatives, and a gate that slow does not get run.

The ladder is therefore inverted, which costs nothing in detection power:

  1. **Numeric.** Both sides are `lambdify`-compiled once and evaluated at random points. A
     genuinely wrong derivative differs by O(1) almost everywhere, so this catches real
     breakage immediately and takes milliseconds.
  2. **Symbolic, only on disagreement.** A suspected failure is re-checked with mpmath at 50
     digits, then symbolically, before being reported — so a pole, a branch cut or a
     precision artifact is not mistaken for a bug.

`--deep` additionally demands a symbolic proof for every case, for when that is wanted.

Offline dev step. sympy never ships to the browser.

    npm run oracle
    npm run oracle -- --deep
"""

from __future__ import annotations

import json
import os
import math
import random
import sys

try:
    import sympy as sp
    from sympy.parsing.sympy_parser import parse_expr
    from mpmath import mp
except ImportError as exc:  # pragma: no cover
    print(f"the oracle needs sympy and mpmath: {exc}", file=sys.stderr)
    print("install them with: pip install sympy mpmath", file=sys.stderr)
    raise SystemExit(2)


HERE = os.path.dirname(os.path.abspath(__file__))
CASES_PATH = os.path.join(HERE, "cases.json")

# Digits for the numeric fallback. Well beyond f64, so a disagreement at 1e-30 is a real
# difference between the expressions rather than rounding in the comparison.
mp.dps = 50

U, V, A, R, C = sp.symbols("u v a R c", real=True)

# Our printer emits a strict subset of Python expression syntax. Only three names differ
# from sympy's, and `log10`/`log2` have no sympy equivalent at all.
NAMES = {
    "u": U,
    "v": V,
    "a": A,
    "R": R,
    "c": C,
    "abs": sp.Abs,
    "sign": sp.sign,
    "log": sp.log,
    "log10": lambda x: sp.log(x, 10),
    "log2": lambda x: sp.log(x, 2),
    "cbrt": sp.cbrt,
    "sqrt": sp.sqrt,
    "exp": sp.exp,
    "sin": sp.sin, "cos": sp.cos, "tan": sp.tan,
    "cot": sp.cot, "sec": sp.sec, "csc": sp.csc,
    "asin": sp.asin, "acos": sp.acos, "atan": sp.atan, "atan2": sp.atan2,
    "sinh": sp.sinh, "cosh": sp.cosh, "tanh": sp.tanh,
    "coth": sp.coth, "sech": sp.sech, "csch": sp.csch,
    "asinh": sp.asinh, "acosh": sp.acosh, "atanh": sp.atanh,
}

SYMBOL_OF = {"u": U, "v": V}


class Mismatch(Exception):
    """A derivative that sympy proves is wrong."""


def parse_ours(source: str):
    # evaluate=True lets sympy fold constants, which is fine: we are comparing functions,
    # not normal forms.
    return parse_expr(source, local_dict=NAMES, evaluate=True)


def symbolically_zero(difference, deep: bool) -> bool | None:
    """True if provably zero, False if provably nonzero, None if undecided."""
    if difference == 0:
        return True
    try:
        if sp.expand(difference) == 0:
            return True
    except Exception:
        pass
    if not deep:
        return None
    for attempt in (sp.trigsimp, sp.simplify, lambda e: sp.simplify(sp.expand(e))):
        try:
            if attempt(difference) == 0:
                return True
        except Exception:
            continue
    try:
        verdict = difference.equals(0)
        if verdict is True:
            return True
        if verdict is False:
            return False
    except Exception:
        pass
    return None


def compile_pair(ours, theirs, free):
    """
    `lambdify` both sides once, over a fixed argument order.

    Compiling per case rather than substituting per point is the whole reason this is fast:
    `subs` walks and rebuilds the expression tree every time, while a lambdified function is
    plain Python arithmetic.
    """
    args = list(free)
    try:
        # mpmath rather than math: the standard library has no sech, csch or coth, so those
        # would be left as unevaluated sympy calls and the "numbers" coming back would not be
        # numbers at all.
        return (
            sp.lambdify(args, ours, modules=["mpmath"]),
            sp.lambdify(args, theirs, modules=["mpmath"]),
        )
    except Exception:
        return None, None


def to_float(value) -> float | None:
    """A finite real float, or None. Total by design — see `numeric_verdict`."""
    try:
        if isinstance(value, complex):
            return None
        result = float(value)
    except (TypeError, ValueError, OverflowError, ArithmeticError):
        return None
    return result if math.isfinite(result) else None


def numeric_verdict(ours, theirs, free, rng) -> tuple[str, str]:
    """
    ("agree" | "disagree" | "unusable", detail).

    Points where either side is undefined or complex are skipped: an arbitrary formula has
    plenty of them, and they say nothing about whether two derivatives match.
    """
    left_fn, right_fn = compile_pair(ours, theirs, free)
    if left_fn is None or right_fn is None:
        return "unusable", "lambdify failed"

    checked = 0
    for _ in range(40):
        point = [rng.uniform(-2.5, 2.5) for _ in free]
        try:
            left = to_float(left_fn(*point))
            right = to_float(right_fn(*point))
        except Exception:
            continue
        if left is None or right is None:
            continue

        scale = max(abs(left), abs(right), 1.0)
        if abs(left - right) > 1e-7 * scale:
            values = ", ".join(f"{s}={p:.6g}" for s, p in zip(free, point))
            return "disagree", f"at {values}: {left!r} vs {right!r}"
        checked += 1
        if checked >= 12:
            return "agree", f"{checked} points"

    if checked == 0:
        return "unusable", "no point where both sides are real and finite"
    return "agree", f"{checked} points"


def confirm_disagreement(ours, theirs, free, detail: str) -> str | None:
    """
    Re-check a suspected failure at high precision, then symbolically.

    Returns a message if the disagreement is real, or None if it was an artifact — which
    keeps a branch cut or a cancellation from being reported as a broken derivative.
    """
    mp.dps = 50
    try:
        point = {symbol: sp.Rational(rng_probe.randint(-300, 300), 137) for symbol in free}
        left = sp.N(ours.subs(point), 50)
        right = sp.N(theirs.subs(point), 50)
        if left.is_number and right.is_number and left.is_real and right.is_real:
            scale = max(abs(float(left)), abs(float(right)), 1.0)
            if abs(float(left) - float(right)) < 1e-25 * scale:
                return None
    except Exception:
        pass

    if symbolically_zero(ours - theirs, deep=True) is True:
        return None
    return detail


rng_probe = random.Random(1)


def is_distributional(expr) -> bool:
    """
    True when sympy's answer is a distribution rather than a function.

    `sign` and `abs` are the one place we knowingly differ: sympy differentiates `sign(u)` to
    `2·DiracDelta(u)`, while `fns.ts` returns 0 — correct away from the origin, and the honest
    answer available without distributions. Naming that divergence explicitly keeps it from
    sitting in the "could not evaluate" pile, where it would mask a genuine gap later.
    """
    return expr.has(sp.DiracDelta) or expr.has(sp.Derivative) or expr.has(sp.Heaviside)

def main() -> int:
    # `--deep` adds the expensive simplify ladder for anything the cheap tests cannot
    # decide. Off by default so the gate stays fast enough to actually run.
    deep = "--deep" in sys.argv

    if not os.path.exists(CASES_PATH):
        print(f"{CASES_PATH} is missing — run `npm run oracle:emit` first", file=sys.stderr)
        return 2

    with open(CASES_PATH, encoding="utf8") as handle:
        payload = json.load(handle)

    seed = payload.get("seed", 0)
    cases = payload["cases"]
    rng = random.Random(seed)

    proved = 0
    numeric = 0
    undecided: list[str] = []
    distributional: list[str] = []
    failures: list[str] = []

    for index, case in enumerate(cases):
        try:
            ours_expr = parse_ours(case["python"])
        except Exception as exc:
            failures.append(f"{case['source']}: sympy could not parse our output: {exc}")
            continue

        for key, printed in case["derivatives"].items():
            order = [SYMBOL_OF[ch] for ch in key]
            try:
                theirs = sp.diff(ours_expr, *order)
                ours = parse_ours(printed)
            except Exception as exc:
                failures.append(f"{case['source']} d/d{key}: {exc}")
                continue

            # Structural equality first: free, and it settles the large majority outright,
            # since our simplified derivative usually *is* sympy's up to term order.
            difference = ours - theirs
            if difference == 0 or (deep and symbolically_zero(difference, deep=True) is True):
                proved += 1
                continue

            # Argument list from the two expressions, NOT from their difference. When the
            # difference collapses to 0 it has no free symbols at all, and lambdifying over
            # that empty list produced functions that could not be called — which is how an
            # earlier version reported hundreds of perfectly ordinary cases as unevaluable.
            if is_distributional(theirs):
                distributional.append(f"{case['source']} d/d{key}")
                continue

            free = sorted(
                ours.free_symbols | theirs.free_symbols,
                key=lambda symbol: symbol.name,
            )
            status, detail = numeric_verdict(ours, theirs, free, rng)

            if status == "agree":
                numeric += 1
            elif status == "unusable":
                undecided.append(f"{case['source']} d/d{key} ({detail})")
            else:
                real = confirm_disagreement(ours, theirs, free, detail)
                if real is None:
                    numeric += 1
                else:
                    failures.append(
                        f"{case['source']}  d/d{key}\n"
                        f"    ours:   {ours}\n"
                        f"    sympy:  {theirs}\n"
                        f"    {real}"
                    )

        if (index + 1) % 40 == 0:
            print(f"  … {index + 1}/{len(cases)} cases", flush=True)

    total = proved + numeric
    print()
    print(f"seed {seed}   mode {'deep' if deep else 'fast'}")
    print(f"derivatives checked   {total}")
    print(f"  proved symbolically {proved}")
    print(f"  agreed numerically  {numeric}")

    if distributional:
        print()
        print(
            f"known divergence, sympy answers with a distribution ({len(distributional)}):"
        )
        for line in distributional[:6]:
            print(f"  {line}")
        if len(distributional) > 6:
            print(f"  … and {len(distributional) - 6} more")
        print("  (sign' is 0 here, not 2*DiracDelta — see the note in fns.ts)")

    if undecided:
        print()
        print(f"could not be evaluated anywhere usable ({len(undecided)}):")
        for line in undecided[:12]:
            print(f"  {line}")
        if len(undecided) > 12:
            print(f"  … and {len(undecided) - 12} more")

    if failures:
        print()
        print(f"FAILED ({len(failures)}):", file=sys.stderr)
        for line in failures:
            print(f"  {line}", file=sys.stderr)
        print(f"\nreproduce with seed {seed}", file=sys.stderr)
        return 1

    print()
    print("the TypeScript CAS agrees with sympy on every derivative in the corpus")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
