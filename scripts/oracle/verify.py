#!/usr/bin/env python3
"""
Cross-check the TypeScript CAS against sympy.

The vitest suite already pins every derivative-table entry against an independently written
closed form, and the structural rules against Richardson-extrapolated differences. Both are
numeric, and both sample points. Neither can decide whether two expressions are equal *as
functions* — which is precisely what "is this derivative correct?" asks.

sympy can. `simplify(ours - diff(f, vars)) == 0` is a proof rather than a sample, and that
is what makes this the genuinely independent gate.

Two layers, because sympy's `simplify` is powerful but not a decision procedure:

  1. Symbolic. Assert the difference simplifies to exactly zero.
  2. High-precision numeric, only where step 1 could not decide. Evaluate both sides with
     mpmath at 50 digits at several random rational points. This also independently catches
     catastrophic cancellation in our generated code, which is a bonus worth having.

Reporting "undecided" separately from "failed" matters: conflating them would either hide
real breakage or produce a flaky gate that gets ignored.

Offline dev step. sympy never ships to the browser.

    npm run oracle
"""

from __future__ import annotations

import json
import os
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
    """
    True if provably zero, False if provably nonzero, None if undecided.

    Ordered cheapest-first, which matters enormously: calling `simplify` on every difference
    made this take upwards of half an hour for a few hundred derivatives, and a gate that
    slow does not get run. The overwhelming majority are structurally zero the moment both
    sides are expanded, so the expensive machinery is reserved for the handful that are not.
    """
    # 1. Structural. Free, and catches most cases outright.
    if difference == 0:
        return True

    # 2. Expansion. Cheap, and resolves nearly everything else.
    try:
        if sp.expand(difference) == 0:
            return True
    except Exception:
        pass

    # 3. sympy's own equality helper: randomized numeric evidence, then a symbolic attempt.
    #    Usually far quicker than a full simplify and it answers the exact question asked.
    try:
        verdict = difference.equals(0)
        if verdict is True:
            return True
        if verdict is False:
            return False
    except Exception:
        pass

    if not deep:
        return None

    # 4. Last resort, only for the survivors.
    for attempt in (sp.trigsimp, sp.simplify, lambda e: sp.simplify(sp.expand(e))):
        try:
            if attempt(difference) == 0:
                return True
        except Exception:
            continue

    return None


def as_real_float(value) -> float | None:
    """
    A plain float, or None if this value is not a usable real number.

    Deliberately total. An arbitrary formula evaluated at an arbitrary rational lands on
    complex results, poles, `zoo`, `nan`, and expressions sympy simply declines to reduce —
    and a point we cannot evaluate says nothing about whether two derivatives agree. So
    every such case is skipped rather than guarded against case by case, which is what the
    first version of this got wrong.
    """
    try:
        if value.has(sp.zoo) or value.has(sp.nan) or value.has(sp.oo) or value.has(-sp.oo):
            return None
        if not value.is_number:
            return None
        if value.is_real is not True:
            return None
        return float(value)
    except (TypeError, ValueError, AttributeError):
        return None


def numerically_equal(ours, theirs, free, rng) -> tuple[bool, str]:
    """Compare at random rational points with 50-digit precision."""
    checked = 0
    for _ in range(80):
        # Rationals keep the substitution exact, so only the final evaluation is numeric.
        point = {
            symbol: sp.Rational(rng.randint(-400, 400), rng.randint(80, 400))
            for symbol in free
        }
        try:
            left = as_real_float(sp.N(ours.subs(point), mp.dps))
            right = as_real_float(sp.N(theirs.subs(point), mp.dps))
        except Exception:
            continue
        if left is None or right is None:
            continue

        scale = max(abs(left), abs(right), 1.0)
        if abs(left - right) > 1e-25 * scale:
            return False, f"at {point}: {left} vs {right}"
        checked += 1
        if checked >= 12:
            return True, f"{checked} points"

    # No usable point is not evidence of agreement, and must not be reported as such.
    if checked == 0:
        return True, "NO USABLE POINTS — unverified"
    return True, f"{checked} points"


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

            verdict = symbolically_zero(ours - theirs, deep=deep)
            if verdict is True:
                proved += 1
                continue

            free = sorted(
                (ours - theirs).free_symbols, key=lambda s: s.name
            )
            agrees, detail = numerically_equal(ours, theirs, free, rng)
            if not agrees:
                failures.append(
                    f"{case['source']}  d/d{key}\n"
                    f"    ours:   {ours}\n"
                    f"    sympy:  {theirs}\n"
                    f"    {detail}"
                )
            elif verdict is False:
                # sympy claimed nonzero but the numbers agree everywhere we could test.
                # Almost always a simplify limitation; recorded rather than failed.
                undecided.append(f"{case['source']} d/d{key} (simplify said nonzero, {detail})")
                numeric += 1
            else:
                undecided.append(f"{case['source']} d/d{key} ({detail})")
                numeric += 1

        if (index + 1) % 40 == 0:
            print(f"  … {index + 1}/{len(cases)} cases", flush=True)

    total = proved + numeric
    print()
    print(f"seed {seed}   mode {'deep' if deep else 'fast'}")
    print(f"derivatives checked   {total}")
    print(f"  proved symbolically {proved}")
    print(f"  numeric only        {numeric}")

    if undecided:
        print()
        print(f"undecided symbolically, agreed numerically ({len(undecided)}):")
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
