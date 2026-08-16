import { describe, expect, it } from "vitest";
import { CURVE_CATALOG } from "../../src/core/catalog/curves.ts";
import { CATALOG, CATALOG_FIELDS } from "../../src/core/catalog/surfaces.ts";
import { sampleBounds } from "../../src/core/geom/types.ts";
import { createDocument, type RowId } from "../../src/state/graph.ts";
import { buildScene, type DomainRange } from "../../src/state/scene.ts";

/**
 * Every template must survive the whole document → scene path.
 *
 * The catalog stores these as source text, so this exercises parse → inline → differentiate →
 * jets → fundamental forms → tessellate for every entry, exactly as the UI does. Loading a
 * template is not a special path, and this asserts that.
 */

/** Mirrors what the template picker does when a surface is chosen. */
function loadSurface(id: string) {
  const spec = CATALOG.find((entry) => entry.id === id)!;
  const document = createDocument([`X(u,v) = (${spec.components.join(", ")})`]);
  const rowId = document.rows()[0]!.id;

  const [u0, u1] = sampleBounds(spec.u);
  const [v0, v1] = sampleBounds(spec.v);
  const domains = new Map<RowId, DomainRange[]>([
    [rowId, [{ min: u0, max: u1 }, { min: v0, max: v1 }]],
  ]);
  const parameters = new Map(spec.params.map((p) => [p.key, p.default]));

  const items = [...document.resolution().items.values()];
  const scene = buildScene({ items, parameters, domains, resolution: 40 });
  return { spec, document, items, scene };
}

/** The same, plus one of that surface's example fields — what the field gallery loads. */
function loadField(surfaceId: string, fieldId: string) {
  const spec = CATALOG.find((entry) => entry.id === surfaceId)!;
  const field = (spec.fields ?? []).find((entry) => entry.id === fieldId)!;
  const document = createDocument([
    `X(u,v) = (${spec.components.join(", ")})`,
    `X: VectorField(${field.components.join(", ")})`,
  ]);
  const [surfaceRow, fieldRow] = document.rows();

  const [u0, u1] = sampleBounds(spec.u);
  const [v0, v1] = sampleBounds(spec.v);
  const domains = new Map<RowId, DomainRange[]>([
    [surfaceRow!.id, [{ min: u0, max: u1 }, { min: v0, max: v1 }]],
  ]);
  const parameters = new Map(spec.params.map((p) => [p.key, p.default]));

  const resolved = document.resolution();
  const scene = buildScene({
    items: [...resolved.items.values()],
    parameters,
    declaredParameters: resolved.declaredParameters,
    domains,
    resolution: 40,
  });
  return {
    spec,
    field,
    document,
    scene,
    diagnostics: resolved.diagnostics.get(fieldRow!.id) ?? [],
    report: scene.reports.find((entry) => entry.rowId === fieldRow!.id),
    arrows: scene.lines.find((group) => group.rowId === surfaceRow!.id),
  };
}

function loadCurve(id: string) {
  const spec = CURVE_CATALOG.find((entry) => entry.id === id)!;
  const document = createDocument([`alpha(t) = (${spec.components.join(", ")})`]);
  const rowId = document.rows()[0]!.id;

  const [t0, t1] = sampleBounds(spec.t);
  const domains = new Map<RowId, DomainRange[]>([[rowId, [{ min: t0, max: t1 }]]]);
  const parameters = new Map(spec.params.map((p) => [p.key, p.default]));

  const items = [...document.resolution().items.values()];
  const scene = buildScene({ items, parameters, domains, resolution: 40 });
  return { spec, document, items, scene };
}

describe("surface templates", () => {
  for (const entry of CATALOG) {
    describe(entry.id, () => {
      it("classifies as a surface with no diagnostics", () => {
        const { document, items } = loadSurface(entry.id);
        const rowId = document.rows()[0]!.id;
        const diagnostics = document.resolution().diagnostics.get(rowId) ?? [];
        expect(
          diagnostics.filter((d) => d.severity === "error"),
          `${entry.id}: ${diagnostics.map((d) => d.message).join("; ")}`,
        ).toEqual([]);
        expect(items[0]?.kind).toBe("parametricSurface");
      });

      it("declares exactly the catalog's parameters as free", () => {
        // The template's parameters must land in the auto-slider machinery, which only
        // happens if they stay symbolic rather than being baked in.
        const { spec, items } = loadSurface(entry.id);
        expect([...items[0]!.params].sort()).toEqual(
          spec.params.map((p) => p.key).sort(),
        );
      });

      it("tessellates without dropping geometry", () => {
        // The point of carrying the inset across. Without it, the sphere and pseudosphere
        // sample their singular boundary and lose a ring of triangles.
        const { scene } = loadSurface(entry.id);
        expect(scene.mesh, `${entry.id} produced no mesh`).not.toBeNull();
        expect(scene.mesh!.triangleCount).toBeGreaterThan(0);
        expect(
          scene.mesh!.droppedTriangles,
          `${entry.id} dropped ${scene.mesh!.droppedTriangles} triangles`,
        ).toBe(0);
      });

      it("emits only finite values to the GPU buffers", () => {
        const { scene } = loadSurface(entry.id);
        for (const value of scene.mesh!.positions) expect(Number.isFinite(value)).toBe(true);
        for (const value of scene.mesh!.normals) expect(Number.isFinite(value)).toBe(true);
        for (const value of scene.mesh!.colors) expect(Number.isFinite(value)).toBe(true);
      });

      it("reports finite curvature at the domain centre", () => {
        const { document, scene } = loadSurface(entry.id);
        const rowId = document.rows()[0]!.id;
        const report = scene.reports.find((r) => r.rowId === rowId);
        expect(report?.errors ?? []).toEqual([]);
        expect((report?.info ?? []).length, `${entry.id} had no readout`).toBeGreaterThan(0);
        expect(report!.info.join(" ")).not.toContain("NaN");
      });
    });
  }

  it("keeps the sphere off its poles", () => {
    // Stated as its own case because it is the specific failure the inset exists to prevent:
    // at u = 0 and u = π the sphere's X_u × X_v vanishes, so the tangent plane — and with it
    // the normal and the curvature — is undefined on the closed interval.
    const spec = CATALOG.find((entry) => entry.id === "sphere")!;
    expect(spec.u.inset).toBeGreaterThan(0);
    const [u0, u1] = sampleBounds(spec.u);
    expect(u0).toBeGreaterThan(0);
    expect(u1).toBeLessThan(Math.PI);

    const { scene } = loadSurface("sphere");
    expect(scene.mesh!.droppedVertices).toBe(0);
  });

  it("gives the sphere constant positive curvature", () => {
    const { scene } = loadSurface("sphere");
    // R defaults to 1, so K = 1 everywhere.
    for (let k = 0; k < scene.mesh!.vertexCount; k += 53) {
      expect(Math.abs(scene.mesh!.curvature[k]! - 1)).toBeLessThan(1e-6);
    }
  });

  it("gives the pseudosphere constant negative curvature", () => {
    const { scene } = loadSurface("pseudosphere");
    for (let k = 0; k < scene.mesh!.vertexCount; k += 53) {
      expect(Math.abs(scene.mesh!.curvature[k]! + 1)).toBeLessThan(1e-5);
    }
  });
});

describe("curve templates", () => {
  for (const entry of CURVE_CATALOG) {
    describe(entry.id, () => {
      it("classifies as a space curve with no diagnostics", () => {
        const { document, items } = loadCurve(entry.id);
        const rowId = document.rows()[0]!.id;
        const diagnostics = document.resolution().diagnostics.get(rowId) ?? [];
        expect(
          diagnostics.filter((d) => d.severity === "error"),
          `${entry.id}: ${diagnostics.map((d) => d.message).join("; ")}`,
        ).toEqual([]);
        expect(items[0]?.kind).toBe("spaceCurve");
      });

      it("samples into a polyline with only finite points", () => {
        const { scene } = loadCurve(entry.id);
        expect(scene.lines.length).toBeGreaterThan(0);
        const line = scene.lines[0]!.polylines[0]!;
        expect(line.count).toBeGreaterThan(100);
        for (const value of line.points) expect(Number.isFinite(value)).toBe(true);
      });

      it("has a readout rather than an error", () => {
        const { document, scene } = loadCurve(entry.id);
        const rowId = document.rows()[0]!.id;
        const report = scene.reports.find((r) => r.rowId === rowId);
        expect(report?.errors ?? []).toEqual([]);
        expect((report?.info ?? []).length).toBeGreaterThan(0);
      });
    });
  }

  it("flags the degenerate templates honestly", () => {
    // The line and the cusp are in the catalog precisely because they are the cases a naive
    // implementation gets wrong, so their readouts must say so rather than showing numbers.
    const line = loadCurve("line");
    const lineReport = line.scene.reports[0]!;
    expect(lineReport.info.join(" ")).toContain("N and B undefined");

    const cusp = loadCurve("cusp");
    const cuspLine = cusp.scene.lines[0]!.polylines[0]!;
    // The polyline breaks at the cusp rather than passing through it.
    let invalid = 0;
    for (let i = 0; i < cuspLine.count; i++) if (!cuspLine.valid?.[i]) invalid++;
    expect(invalid).toBeGreaterThan(0);
  });
});

/**
 * The catalog's example fields, checked against the one property that makes them fields **on**
 * their surface rather than near it.
 *
 * A field is written in ambient components, so tangency is a claim about the formula and the
 * parametrization together — exactly the kind of claim that survives being edited into being
 * false. Every entry is combination of the patch's own coordinate fields, so ⟨V, N⟩ must vanish
 * identically, and the scene's own check is what reports it.
 */
describe("vector field templates", () => {
  for (const { spec, field } of CATALOG_FIELDS) {
    describe(`${spec.id} · ${field.id}`, () => {
      it("parses and classifies as a field on the patch", () => {
        const { document, diagnostics } = loadField(spec.id, field.id);
        expect(
          diagnostics.filter((d) => d.severity === "error"),
          `${field.id}: ${diagnostics.map((d) => d.message).join("; ")}`,
        ).toEqual([]);
        const item = document.resolution().items.get(document.rows()[1]!.id);
        expect(item?.kind).toBe("surfaceField");
        expect(item?.host).toBe("X");
      });

      it("is tangent everywhere it is drawn", () => {
        const { report } = loadField(spec.id, field.id);
        // The scene measures |⟨V,N⟩|/|V| at every arrow and warns past a quarter of a degree.
        expect(report?.warnings ?? [], `${field.id} is not tangent`).toEqual([]);
        expect(report?.errors ?? []).toEqual([]);
      });

      it("draws arrows, all of them finite", () => {
        const { arrows } = loadField(spec.id, field.id);
        expect(arrows, `${field.id} drew nothing`).toBeDefined();
        expect(arrows!.polylines.length).toBeGreaterThan(50);
        for (const arrow of arrows!.polylines) {
          for (const value of arrow.points) expect(Number.isFinite(value)).toBe(true);
        }
      });
    });
  }

  it("gives every catalog surface at least one field to look at", () => {
    // Not a rule about the catalog so much as a check that none was dropped in editing: each
    // surface's own coordinate fields are always available, so there is no excuse for a blank.
    for (const spec of CATALOG) {
      expect((spec.fields ?? []).length, `${spec.id} has no example field`).toBeGreaterThan(0);
    }
  });
});
