import { describe, expect, it } from "vitest";
import {
  COLORMAP_NAMES,
  colormapColor,
  colormapGradient,
  type ColormapName,
} from "../../src/core/geom/colormaps.ts";
import type { Vec3 } from "../../src/core/geom/types.ts";

/**
 * Colour is presentation, but two of its properties are claims about the mathematics and have to
 * hold: the diverging map must be centred on K = 0, and every map must stay in range so nothing
 * reaches a GPU buffer that cannot be displayed.
 */

const BASE: Vec3 = [0.2, 0.4, 0.6];
const of = (name: ColormapName, t: number): Vec3 => colormapColor(name, t, [0, 0, 0], BASE);

describe("colour maps", () => {
  it("keeps every channel in [0, 1] across and beyond the range", () => {
    for (const name of COLORMAP_NAMES) {
      for (const t of [-1e6, -3, -1, -0.5, 0, 0.5, 1, 3, 1e6]) {
        for (const channel of of(name, t)) {
          expect(channel, `${name} at ${t}`).toBeGreaterThanOrEqual(0);
          expect(channel, `${name} at ${t}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("saturates outside [-1, 1] rather than extrapolating", () => {
    for (const name of COLORMAP_NAMES) {
      expect(of(name, 5), name).toEqual(of(name, 1));
      expect(of(name, -5), name).toEqual(of(name, -1));
    }
  });

  it("gives the curvature map a neutral middle and opposing arms", () => {
    /**
     * The property that makes it the right default: K has a meaningful zero, and a diverging map
     * shows the sign at a glance. If the midpoint were not distinct from both ends, elliptic and
     * hyperbolic regions would stop being distinguishable — which is most of what the picture is
     * for.
     */
    const negative = of("curvature", -1);
    const zero = of("curvature", 0);
    const positive = of("curvature", 1);

    const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(distance(negative, positive)).toBeGreaterThan(0.5);
    expect(distance(negative, zero)).toBeGreaterThan(0.3);
    expect(distance(positive, zero)).toBeGreaterThan(0.3);
    // Blue for negative, red for positive, following do Carmo's saddle/dome intuition.
    expect(negative[2]).toBeGreaterThan(negative[0]);
    expect(positive[0]).toBeGreaterThan(positive[2]);
  });

  it("keeps the neutral end clearly below white, so a plane is not a hole in the page", () => {
    // The background is white; a K = 0 surface painted near-white would vanish into it.
    const zero = of("curvature", 0);
    for (const channel of zero) expect(channel).toBeLessThan(0.93);
  });

  it("returns the surface's own colour for the solid map", () => {
    for (const t of [-1, 0, 1]) expect(of("solid", t)).toEqual(BASE);
  });

  it("moves monotonically along a sequential map", () => {
    // Sequential maps order magnitudes; that is the whole reason to offer them, so the ramp must
    // not double back.
    for (const name of ["viridis", "plasma", "grey"] as const) {
      let previous = -1;
      for (let i = 0; i <= 20; i++) {
        const t = -1 + (2 * i) / 20;
        const [r, g, b] = of(name, t);
        // Luminance rather than any single channel, since viridis and plasma turn in hue.
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        expect(luminance, `${name} at ${t}`).toBeGreaterThan(previous - 1e-9);
        previous = luminance;
      }
    }
  });

  it("emits a gradient the legend can use, and nothing for solid", () => {
    expect(colormapGradient("curvature")).toContain("linear-gradient");
    // A solid colour has no ramp to label; the legend has to show nothing rather than a lie.
    expect(colormapGradient("solid")).toBe("transparent");
  });
});
