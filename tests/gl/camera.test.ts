import { describe, expect, it } from "vitest";
import { createCamera } from "../../src/gl/camera.ts";

/**
 * The camera's handedness, which is not a convention to choose.
 *
 * `right` had been computed as `worldUp × forward` — the negative of the correct
 * `forward × worldUp` — so A and D moved the wrong way, and every "place it beside that one"
 * offset went to the wrong side. It survived because the formula existed in two places and
 * neither had anything checking it.
 */

describe("the camera basis", () => {
  it("puts the viewer's right at world +y when looking down −x, with z up", () => {
    // The one case where the answer is obvious by inspection: standing on +x, facing the origin,
    // with z up. Anything else is this rotated, so getting this right gets them all right.
    // Up is z because the mathematics is: every surface here puts its axis of symmetry there.
    const camera = createCamera();
    camera.frame([0, 0, 0], 1);
    camera.restore({ theta: 0, phi: Math.PI / 2, radius: 5, target: [0, 0, 0] });

    const { forward, right, up } = camera.basis();
    expect(forward[0]).toBeLessThan(-0.99);
    expect(right[1]).toBeGreaterThan(0.99);
    expect(up[2]).toBeGreaterThan(0.99);
  });

  it("keeps the three axes orthonormal from any angle", () => {
    const camera = createCamera();
    for (const theta of [0, 0.7, 2.1, -1.3, 5.9]) {
      for (const phi of [0.05, 0.6, 1.57, 2.4, 3.09]) {
        camera.restore({ theta, phi, radius: 3, target: [1, -2, 0.5] });
        const { forward, right, up } = camera.basis();
        const dot = (a: readonly number[], b: readonly number[]) =>
          a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
        const label = `theta ${theta} phi ${phi}`;
        expect(Math.hypot(...forward), label).toBeCloseTo(1, 9);
        expect(Math.hypot(...right), label).toBeCloseTo(1, 9);
        expect(Math.hypot(...up), label).toBeCloseTo(1, 9);
        expect(dot(forward, right), label).toBeCloseTo(0, 9);
        expect(dot(forward, up), label).toBeCloseTo(0, 9);
        expect(dot(right, up), label).toBeCloseTo(0, 9);
      }
    }
  });

  it("is right-handed: right × up points back along the view", () => {
    // The invariant that fixes the sign for good, independently of any one viewpoint.
    const camera = createCamera();
    camera.restore({ theta: 1.1, phi: 0.9, radius: 4, target: [0, 0, 0] });
    const { forward, right, up } = camera.basis();
    const cross: [number, number, number] = [
      right[1] * up[2] - right[2] * up[1],
      right[2] * up[0] - right[0] * up[2],
      right[0] * up[1] - right[1] * up[0],
    ];
    for (const k of [0, 1, 2]) expect(cross[k]).toBeCloseTo(-forward[k]!, 9);
  });

  it("round-trips its own state", () => {
    // Restoring is what carries a view across a hot reload; a lossy round trip would move the
    // camera every time an edit was applied.
    const camera = createCamera();
    const saved = { theta: 0.4, phi: 1.2, radius: 7.5, target: [1, 2, 3] as const };
    camera.restore(saved);
    const read = camera.state();
    expect(read.theta).toBeCloseTo(saved.theta, 12);
    expect(read.phi).toBeCloseTo(saved.phi, 12);
    expect(read.radius).toBeCloseTo(saved.radius, 12);
    expect([...read.target]).toEqual([...saved.target]);
  });
});
