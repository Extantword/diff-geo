import { describe, expect, it } from "vitest";
import { buildSurface, CATALOG_BY_ID, paramsWith } from "../../src/core/catalog/surfaces.ts";
import { gaussImage, meshArea, totalAbsoluteCurvature } from "../../src/core/mesh/gaussMap.ts";
import { tessellate } from "../../src/core/mesh/tessellate.ts";

/**
 * The Gauss map's defining property is that its area distortion is |K| (do Carmo §3-3), so the
 * image's area must equal ∫|K| dA over the source. That single identity checks the normals and the
 * curvatures against each other, which is why it is worth more here than any number of spot checks
 * on individual normals.
 */

const closeRel = (a: number, b: number, rel: number) =>
  expect(Math.abs(a - b)).toBeLessThan(rel * Math.max(Math.abs(a), Math.abs(b), 1e-12));

function meshOf(id: string, overrides: Readonly<Record<string, number>> = {}, res = 160) {
  const spec = CATALOG_BY_ID[id]!;
  const { surface } = buildSurface(spec);
  const params = paramsWith(spec, overrides);
  return tessellate(surface, params, { resU: res, resV: res });
}

describe("the Gauss map as a mesh", () => {
  it("sends every point of a sphere to the unit sphere", () => {
    // The Gauss map of a sphere of radius R is a diffeomorphism onto S², independent of R — the
    // clearest statement that the image lives on the sphere of directions, not of positions.
    for (const R of [0.25, 1, 7]) {
      const image = gaussImage(meshOf("sphere", { R }, 60));
      for (let k = 0; k < image.vertexCount; k++) {
        const r = Math.hypot(
          image.positions[k * 3]!,
          image.positions[k * 3 + 1]!,
          image.positions[k * 3 + 2]!,
        );
        // Vertices dropped for degeneracy have no normal and land at the origin; they are
        // unreferenced by any triangle, so skip them rather than assert on meaningless data.
        if (r === 0) continue;
        closeRel(r, 1, 1e-5);
      }
    }
  });

  it("collapses a cylinder's image to a circle, which is what K = 0 looks like", () => {
    /**
     * The image of a cylinder is one-dimensional: the normal never has a z component and sweeps a
     * single circle. So the image has essentially no AREA, which is the geometric content of
     * K = 0 — and a much stronger statement than reading K ≈ 0 off a readout.
     */
    const image = gaussImage(meshOf("cylinder", {}, 60));
    expect(meshArea(image)).toBeLessThan(1e-6);

    let maxAbsZ = 0;
    for (let k = 0; k < image.vertexCount; k++) {
      const r = Math.hypot(image.positions[k * 3]!, image.positions[k * 3 + 1]!);
      if (r === 0) continue;
      maxAbsZ = Math.max(maxAbsZ, Math.abs(image.positions[k * 3 + 2]!));
    }
    expect(maxAbsZ).toBeLessThan(1e-6);
  });

  it("gives the unit sphere's area as the total curvature of a sphere", () => {
    // ∫K dA = 4π for any sphere, so the image covers S² exactly once. Both sides are computed
    // from the mesh, one through the normals and one through the curvatures.
    for (const R of [0.5, 1, 3]) {
      const mesh = meshOf("sphere", { R }, 200);
      const image = gaussImage(mesh);
      closeRel(meshArea(image), 4 * Math.PI, 0.02);
      closeRel(totalAbsoluteCurvature(mesh), 4 * Math.PI, 0.02);
    }
  });

  it("matches image area to ∫|K| dA on surfaces where K changes sign", () => {
    /**
     * The identity is per-triangle, so it holds whether or not the Gauss map is injective — on a
     * torus it is two-to-one over part of the sphere, and the areas still agree because each
     * triangle's image is scaled by |K| regardless of what it overlaps.
     *
     * This is the case that would catch a sign error in the normal or a mismatch between the
     * normal used for shading and the one K was computed from.
     */
    for (const id of ["torus", "catenoid", "hyperbolic-paraboloid"]) {
      const mesh = meshOf(id, {}, 220);
      const image = gaussImage(mesh);
      closeRel(meshArea(image), totalAbsoluteCurvature(mesh), 0.05);
    }
  });

  it("places and scales the image without changing its shape", () => {
    const mesh = meshOf("torus", {}, 40);
    const plain = gaussImage(mesh);
    const moved = gaussImage(mesh, { radius: 3, center: [10, -2, 5] });
    // Area scales as the square of the radius; the centre must not affect it at all.
    closeRel(meshArea(moved), meshArea(plain) * 9, 1e-4);
    /**
     * Compared with an ABSOLUTE tolerance, not a relative one. Undoing a centre of 10 from
     * positions held in float32 costs about 1e-6 of precision, so a coordinate whose true value is
     * zero comes back as rounding noise — and no relative test against zero can survive that.
     */
    for (let k = 0; k < moved.vertexCount; k++) {
      const px = plain.positions[k * 3]!;
      const py = plain.positions[k * 3 + 1]!;
      const pz = plain.positions[k * 3 + 2]!;
      if (Math.hypot(px, py, pz) === 0) continue;
      expect(Math.abs(moved.positions[k * 3]! - 10 - px * 3)).toBeLessThan(1e-5);
      expect(Math.abs(moved.positions[k * 3 + 1]! + 2 - py * 3)).toBeLessThan(1e-5);
      expect(Math.abs(moved.positions[k * 3 + 2]! - 5 - pz * 3)).toBeLessThan(1e-5);
    }
  });

  it("keeps vertex k of the image the image of vertex k", () => {
    // The correspondence is what makes the two meshes readable side by side, so colours, chart
    // coordinates and ids must be shared rather than resampled.
    const mesh = meshOf("torus", {}, 24);
    const image = gaussImage(mesh);
    expect(image.colors).toBe(mesh.colors);
    expect(image.chart).toBe(mesh.chart);
    expect(image.ids).toBe(mesh.ids);
    expect(image.indices).toBe(mesh.indices);
    expect(image.curvature).toBe(mesh.curvature);
  });
});
