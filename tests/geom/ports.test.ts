import { describe, expect, it } from "vitest";
import {
  CATALOG_BY_ID,
  buildSurface,
  type SurfaceSpec,
} from "../../src/core/catalog/surfaces.ts";
import { PIECES } from "../../src/core/catalog/pieces.ts";
import { createParametricSurface, type ParametricSurface } from "../../src/core/geom/parametric.ts";
import {
  detectPeriod,
  detectPeriodicity,
  detectPoles,
  type ChartPoles,
} from "../../src/core/geom/periodic.ts";
import {
  applyPlacement,
  detectPorts,
  matePlacement,
  portMismatch,
  transformPort,
  type Port,
} from "../../src/core/geom/ports.ts";
import { quatFromAxisAngle } from "../../src/core/num/quat.ts";
import { interval, type Interval, type Vec3 } from "../../src/core/geom/types.ts";

/**
 * Ports: what a surface offers to be joined to.
 *
 * The claims worth testing are that measurement agrees with what the geometry obviously is — a
 * cylinder has two rims of its own radius and a sphere has no edge at all — and that mating two
 * ports really does bring them together, which is checked by transforming the plug and comparing
 * frames rather than by looking at a picture.
 */

const close = (a: number, b: number, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;
const closeVec = (a: Vec3, b: readonly number[], tolerance = 1e-9) =>
  a.every((value, index) => close(value, b[index]!, tolerance));

/** Compile a parametrization the way the app does: periodicity and poles both measured. */
function compile(
  components: readonly [string, string, string],
  u: Interval,
  v: Interval,
): { surface: ParametricSurface; params: Float64Array; poles: ChartPoles } {
  const spec: SurfaceSpec = {
    id: "under-test",
    name: "under test",
    blurb: "",
    components,
    params: [],
    u,
    v,
  };
  const built = buildSurface(spec);
  const periodic = detectPeriodicity(built.surface, built.params);
  const poles = detectPoles(built.surface, built.params);
  const surface = createParametricSurface({
    id: "under-test",
    map: built.surface.map,
    u,
    v,
    periodicU: periodic.u,
    periodicV: periodic.v,
  });
  return { surface, params: built.params, poles };
}

function portsOf(
  components: readonly [string, string, string],
  u: Interval,
  v: Interval,
): Port[] {
  const { surface, params, poles } = compile(components, u, v);
  return detectPorts(surface, params, poles);
}

describe("detectPorts", () => {
  it("gives a cylinder its two rims, of its own radius", () => {
    // r = 1 baked in, so the ports can be compared against a number rather than a parameter.
    const ports = portsOf(["cos u", "sin u", "v"], interval(0, 2 * Math.PI), interval(-2, 2));

    expect(ports.map((port) => port.boundary).sort()).toEqual(["vMax", "vMin"]);
    for (const port of ports) {
      expect(port.kind).toBe("circle");
      expect(close(port.size, 1, 1e-9)).toBe(true);
      expect(port.deviation).toBeLessThan(1e-9);
    }

    const bottom = ports.find((port) => port.boundary === "vMin")!;
    const top = ports.find((port) => port.boundary === "vMax")!;
    expect(closeVec(bottom.origin, [0, 0, -2], 1e-9)).toBe(true);
    expect(closeVec(top.origin, [0, 0, 2], 1e-9)).toBe(true);
    // Each axis points out of the patch, so they are opposite each other.
    expect(closeVec(bottom.axis, [0, 0, -1], 1e-9)).toBe(true);
    expect(closeVec(top.axis, [0, 0, 1], 1e-9)).toBe(true);
    // And perpendicular to the phase reference, which is what makes the frame a frame.
    for (const port of ports) {
      const d = port.axis[0] * port.up[0] + port.axis[1] * port.up[1] + port.axis[2] * port.up[2];
      expect(close(d, 0, 1e-12)).toBe(true);
    }
  });

  it("gives a sphere none: two poles and a seam are not edges", () => {
    const sphere = CATALOG_BY_ID["sphere"]!;
    // R as a literal: a catalog parameter compiles to a slot this test has no way to fill.
    expect(portsOf(["sin u cos v", "sin u sin v", "cos u"], sphere.u, sphere.v)).toEqual([]);
  });

  it("gives a torus none: it has no boundary at all", () => {
    const torus = CATALOG_BY_ID["torus"]!;
    // R and r as literals, since a catalog parameter would compile to a slot this test cannot fill.
    expect(
      portsOf(
        ["(2 + 0.7cos u) cos v", "(2 + 0.7cos u) sin v", "0.7sin u"],
        torus.u,
        torus.v,
      ),
    ).toEqual([]);
  });

  it("gives a flat patch four straight edges", () => {
    const ports = portsOf(["u", "v", "0"], interval(-1, 1), interval(-1, 1));
    expect(ports.map((port) => port.boundary)).toEqual(["uMin", "uMax", "vMin", "vMax"]);
    for (const port of ports) {
      expect(port.kind).toBe("segment");
      expect(close(port.size, 1, 1e-12)).toBe(true);
      expect(port.deviation).toBeLessThan(1e-12);
    }
    // The outward axis of each edge points away from the patch.
    expect(closeVec(ports[0]!.axis, [-1, 0, 0], 1e-12)).toBe(true);
    expect(closeVec(ports[1]!.axis, [1, 0, 0], 1e-12)).toBe(true);
    expect(closeVec(ports[2]!.axis, [0, -1, 0], 1e-12)).toBe(true);
    expect(closeVec(ports[3]!.axis, [0, 1, 0], 1e-12)).toBe(true);
  });

  it("takes a flat disc's rim axis from its normal, not from the chart running out", () => {
    // The chart's outward direction is radial, which lies IN the plane of the boundary circle, so
    // the usual sign test has nothing to say here. Getting this wrong makes a disc stand up in the
    // tube it is meant to cap.
    const disc = ["u cos v", "u sin v", "0"] as const;
    const ports = portsOf(disc, interval(0.004, 1), interval(0, 2 * Math.PI));
    expect(ports).toHaveLength(1);
    const rim = ports[0]!;
    expect(rim.boundary).toBe("uMax");
    expect(close(Math.abs(rim.axis[2]), 1, 1e-9)).toBe(true);
    expect(close(rim.size, 1, 1e-9)).toBe(true);
  });

  it("finds the centre even when the boundary is swept unevenly", () => {
    // The same unit circle, traced at a wildly varying rate. A centroid of the samples would be
    // pulled off centre; the least-squares fit is exact for any distribution of points that
    // genuinely lie on a circle, which is the property being bought.
    const ports = portsOf(
      ["cos(v + 0.6sin v)", "sin(v + 0.6sin v)", "u"],
      interval(0, 1),
      interval(0, 2 * Math.PI),
    );
    expect(ports).toHaveLength(2);
    for (const port of ports) {
      expect(closeVec([port.origin[0], port.origin[1], 0], [0, 0, 0], 1e-6)).toBe(true);
      expect(close(port.size, 1, 1e-6)).toBe(true);
    }
  });
});

describe("matePlacement", () => {
  const tube = () => portsOf(["cos u", "sin u", "v"], interval(0, 2 * Math.PI), interval(-2, 2));

  it("brings the two ports together, facing each other", () => {
    const socket = tube().find((port) => port.boundary === "vMax")!;
    const plug = tube().find((port) => port.boundary === "vMin")!;

    const placed = transformPort(plug, matePlacement(socket, plug));

    expect(closeVec(placed.origin, socket.origin, 1e-12)).toBe(true);
    // Both axes point out of their own patch, so a join has them opposed.
    expect(closeVec(placed.axis, socket.axis.map((c) => -c), 1e-12)).toBe(true);
    // Roll zero lines the phase references up, so the two v = 0 seams meet.
    expect(closeVec(placed.up, socket.up, 1e-12)).toBe(true);
  });

  it("carries the whole piece, not just the port", () => {
    const socket = tube().find((port) => port.boundary === "vMax")!;
    const plug = tube().find((port) => port.boundary === "vMin")!;
    const placement = matePlacement(socket, plug);

    // The far rim of the joined tube sits one length beyond the join, along the socket's axis.
    const farRim = tube().find((port) => port.boundary === "vMax")!;
    const moved = transformPort(farRim, placement);
    expect(closeVec(moved.origin, [0, 0, 6], 1e-12)).toBe(true);

    // And the joined tube's surface is where the parametrization says, rigidly moved: a point at
    // (u, v) = (0, −2) is the rim point (1, 0, −2) locally, which lands on the socket's rim.
    const local: Vec3 = [1, 0, -2];
    const world: Vec3 = [0, 0, 0];
    applyPlacement(placement, local, world);
    expect(close(Math.hypot(world[0], world[1]), 1, 1e-12)).toBe(true);
    expect(close(world[2], 2, 1e-12)).toBe(true);
  });

  it("turns the piece about the shared axis by the roll, and nothing else", () => {
    const socket = tube().find((port) => port.boundary === "vMax")!;
    const plug = tube().find((port) => port.boundary === "vMin")!;

    const rolled = transformPort(plug, matePlacement(socket, plug, Math.PI / 2));
    expect(closeVec(rolled.origin, socket.origin, 1e-12)).toBe(true);
    expect(closeVec(rolled.axis, socket.axis.map((c) => -c), 1e-12)).toBe(true);

    const expected: Vec3 = [0, 0, 0];
    const q = quatFromAxisAngle(socket.axis, Math.PI / 2);
    const [x, y, z] = socket.up;
    // quatRotate through the same path the mate uses, so this compares the result and not the
    // implementation of the rotation itself.
    applyPlacement({ rotation: q, translation: [0, 0, 0] }, [x, y, z], expected);
    expect(closeVec(rolled.up, expected, 1e-12)).toBe(true);
  });
});

describe("the parts bin", () => {
  for (const piece of PIECES) {
    it(`${piece.name} has the entry and exit it declares, at the size asked for`, () => {
      const size = 0.8;
      const build = piece.build(size);
      const ports = portsOf(build.components, build.u, build.v);

      const entry = ports.find((port) => port.boundary === piece.entry);
      expect(entry, `${piece.id} has no ${piece.entry} port`).toBeDefined();
      expect(entry!.kind).toBe(piece.plug);
      // Sized to the socket, so the two boundaries coincide exactly rather than nearly.
      expect(close(entry!.size, size, 1e-9)).toBe(true);
      expect(entry!.deviation).toBeLessThan(1e-6);

      if (piece.exit) {
        const exit = ports.find((port) => port.boundary === piece.exit);
        expect(exit, `${piece.id} has no ${piece.exit} port`).toBeDefined();
        expect(exit!.kind).toBe(piece.plug);
      } else {
        // A cap really does close things off: nothing else is left to attach to.
        expect(ports).toHaveLength(1);
      }
    });
  }

  it("a tube and a dome of the same socket size have matching rims", () => {
    const tube = PIECES.find((piece) => piece.id === "tube")!.build(0.8);
    const dome = PIECES.find((piece) => piece.id === "dome")!.build(0.8);
    const rim = portsOf(tube.components, tube.u, tube.v).find((p) => p.boundary === "uMax")!;
    const cap = portsOf(dome.components, dome.u, dome.v)[0]!;

    const mismatch = portMismatch(rim, cap);
    expect(mismatch.compatible).toBe(true);
    expect(mismatch.relative).toBeLessThan(1e-6);

    // Joined, the dome's rim lands on the tube's and its pole stands one radius beyond it.
    const placement = matePlacement(rim, cap);
    const pole: Vec3 = [0, 0, 0];
    applyPlacement(placement, [0, 0, 0.8], pole);
    expect(closeVec(pole, [0, 0, 1.6 + 0.8], 1e-6)).toBe(true);
  });

  it("chains: an elbow on a tube leaves its far rim turned by a right angle", () => {
    const tube = PIECES.find((piece) => piece.id === "tube")!.build(1);
    const elbow = PIECES.find((piece) => piece.id === "elbow")!.build(1);
    const socket = portsOf(tube.components, tube.u, tube.v).find((p) => p.boundary === "uMax")!;
    const elbowPorts = portsOf(elbow.components, elbow.u, elbow.v);
    const entry = elbowPorts.find((p) => p.boundary === "uMin")!;
    const exit = elbowPorts.find((p) => p.boundary === "uMax")!;

    const placed = transformPort(exit, matePlacement(socket, entry));
    // The tube runs along +z and the elbow turns a quarter circle, so the far rim faces
    // sideways — its axis is a unit vector with no z component left at all.
    expect(close(placed.axis[2], 0, 1e-9)).toBe(true);
    expect(close(Math.hypot(placed.axis[0], placed.axis[1]), 1, 1e-9)).toBe(true);
    // The bend is on a radius of 2, so the far rim sits two units along and two units up from the
    // join at (0, 0, 2) — the quarter circle's other end.
    expect(closeVec(placed.origin, [-2, 0, 4], 1e-9)).toBe(true);
  });
});

describe("where a coordinate starts repeating", () => {
  const period = (
    components: readonly [string, string, string],
    u: Interval,
    v: Interval,
    alongU: boolean,
  ) => {
    const { surface, params } = compile(components, u, v);
    return detectPeriod(surface, params, alongU);
  };

  it("finds a full turn on a cylinder, from bounds that already close", () => {
    // The cheap case: the domain IS one period, so the width is the answer exactly.
    const found = period(["cos u", "sin u", "v"], interval(0, 2 * Math.PI), interval(-2, 2), true);
    expect(found).toBeCloseTo(2 * Math.PI, 12);
  });

  it("finds it from a domain narrowed to part of a turn", () => {
    /**
     * The case that matters for a control: a bound already dragged inward must not lose the wall,
     * or the next drag walks straight past it and draws the surface over itself.
     */
    const found = period(["cos u", "sin u", "v"], interval(0, 1.1), interval(-2, 2), true);
    expect(found).not.toBeNull();
    expect(found!).toBeCloseTo(2 * Math.PI, 4);
  });

  it("finds a half turn where the surface repeats twice as often", () => {
    // X(u) = (cos 2u, sin 2u, v) comes back to itself after π, not 2π.
    const found = period(["cos(2u)", "sin(2u)", "v"], interval(0, 1.1), interval(-2, 2), true);
    expect(found).not.toBeNull();
    expect(found!).toBeCloseTo(Math.PI, 4);
  });

  it("says nothing repeats on a plane, or along a helicoid's axis", () => {
    expect(period(["u", "v", "0"], interval(-1, 1), interval(-1, 1), true)).toBeNull();
    // The helicoid returns to the same (x, y) after 2π but has climbed, so it never repeats.
    expect(
      period(["u cos v", "u sin v", "0.5v"], interval(-1.8, 1.8), interval(0, 2), false),
    ).toBeNull();
  });

  it("finds the sphere's seam in v, and the full turn its u takes to come back", () => {
    /**
     * What is measured is when the map returns to the SAME POINT for the same other coordinate,
     * which for the sphere's u is a full 2π: past π it is already retracing the sphere, but with
     * v shifted by π rather than pointwise. Detecting that would be detecting self-intersection
     * in general, which is a global problem; this catches the repeat, which is the case a domain
     * control walks into — a tube swept past a full turn draws over itself exactly.
     */
    const sphere: readonly [string, string, string] = ["sin u cos v", "sin u sin v", "cos u"];
    const u = interval(0.01, Math.PI - 0.01);
    const v = interval(0, 1.0);
    expect(period(sphere, u, v, false)).toBeCloseTo(2 * Math.PI, 4);
    expect(period(sphere, u, v, true)).toBeCloseTo(2 * Math.PI, 4);
  });
});
