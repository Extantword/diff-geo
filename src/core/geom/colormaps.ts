import type { Vec3 } from "./types.ts";

/**
 * Colour maps for painting a scalar field — Gaussian curvature — onto a surface.
 *
 * ## Diverging and sequential are not interchangeable here
 *
 * K has a **meaningful zero**: K > 0 is elliptic and dome-like, K < 0 is hyperbolic and
 * saddle-like, and K = 0 separates them. A *diverging* map has a neutral midpoint and two
 * opposing arms, so the sign is visible at a glance and the zero set shows up as a band — on a
 * torus, the two circles where it changes character. That is why `curvature` is the default and
 * why it is the one to reach for when the question is about shape.
 *
 * A *sequential* map like viridis has no midpoint. It orders magnitudes beautifully and is
 * perceptually uniform — equal steps in K look like equal steps in colour, which the diverging map
 * does not promise — but it renders K = 0 as an arbitrary colour partway along a ramp, and the
 * elliptic/hyperbolic distinction is simply gone. Offered because "where is curvature largest" is
 * a real question too, but it answers a different one.
 *
 * All maps take `t` in [−1, 1], already divided by the robust scale, and saturate outside it.
 */

export type ColormapName = "curvature" | "viridis" | "plasma" | "grey" | "solid";

export const COLORMAP_NAMES: readonly ColormapName[] = [
  "curvature",
  "viridis",
  "plasma",
  "grey",
  "solid",
];

/** What to call each in a menu, and what it is for. */
export const COLORMAP_LABEL: Readonly<Record<ColormapName, string>> = {
  curvature: "curvature (signed)",
  viridis: "viridis",
  plasma: "plasma",
  grey: "greyscale",
  solid: "solid colour",
};

/** K < 0 — hyperbolic, saddle-like. */
const NEGATIVE: Vec3 = [0.10, 0.38, 0.88];
/**
 * K ≈ 0 — flat.
 *
 * Light, but deliberately NOT near-white: on a white background the neutral end of the scale is
 * the one that can disappear into the page, and a plane reading as a hole in the canvas is the
 * worst failure this colormap can have.
 */
const ZERO: Vec3 = [0.86, 0.88, 0.90];
/** K > 0 — elliptic, dome-like. */
const POSITIVE: Vec3 = [0.86, 0.20, 0.14];

/**
 * Control points, sampled from the published perceptually-uniform maps and interpolated linearly.
 *
 * Nine stops rather than the full 256-entry tables: the surfaces here are smooth and the mesh is
 * dense, so the piecewise-linear error is far below what the eye can separate, and it keeps the
 * table readable.
 */
const VIRIDIS: readonly Vec3[] = [
  [0.267, 0.005, 0.329],
  [0.283, 0.141, 0.458],
  [0.254, 0.265, 0.530],
  [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558],
  [0.128, 0.567, 0.551],
  [0.135, 0.659, 0.518],
  [0.267, 0.749, 0.441],
  [0.478, 0.821, 0.318],
];

const PLASMA: readonly Vec3[] = [
  [0.050, 0.030, 0.528],
  [0.294, 0.011, 0.631],
  [0.472, 0.000, 0.658],
  [0.630, 0.089, 0.612],
  [0.762, 0.219, 0.505],
  [0.866, 0.352, 0.396],
  [0.944, 0.492, 0.291],
  [0.985, 0.653, 0.188],
  [0.951, 0.832, 0.140],
];

/** Sample a stop table at `s` in [0, 1]. */
function ramp(table: readonly Vec3[], s: number, out: Vec3): Vec3 {
  const clamped = Math.max(0, Math.min(1, s));
  const scaled = clamped * (table.length - 1);
  const index = Math.min(table.length - 2, Math.floor(scaled));
  const amount = scaled - index;
  const a = table[index]!;
  const b = table[index + 1]!;
  out[0] = a[0] + (b[0] - a[0]) * amount;
  out[1] = a[1] + (b[1] - a[1]) * amount;
  out[2] = a[2] + (b[2] - a[2]) * amount;
  return out;
}

/**
 * Colour for `t` in [−1, 1] under the named map.
 *
 * `solid` is not a map at all — it returns `base`, which is how a surface is shown in its own
 * colour rather than painted with a measurement. It is handled here so every caller has one code
 * path and nothing has to special-case "no colouring".
 */
export function colormapColor(
  name: ColormapName,
  t: number,
  out: Vec3,
  base: Vec3,
): Vec3 {
  if (name === "solid") {
    out[0] = base[0];
    out[1] = base[1];
    out[2] = base[2];
    return out;
  }

  const clamped = Math.max(-1, Math.min(1, t));
  switch (name) {
    case "curvature": {
      // Two arms from a neutral middle, so the SIGN of K is what the eye reads first.
      const from = clamped < 0 ? NEGATIVE : POSITIVE;
      const amount = 1 - Math.abs(clamped);
      out[0] = from[0] + (ZERO[0] - from[0]) * amount;
      out[1] = from[1] + (ZERO[1] - from[1]) * amount;
      out[2] = from[2] + (ZERO[2] - from[2]) * amount;
      return out;
    }
    case "viridis":
      return ramp(VIRIDIS, (clamped + 1) / 2, out);
    case "plasma":
      return ramp(PLASMA, (clamped + 1) / 2, out);
    case "grey":
      // Dark for negative, light for positive; kept off both ends so it stays visible against a
      // white page and never reads as a hole.
      return ramp([[0.15, 0.15, 0.16], [0.88, 0.89, 0.90]], (clamped + 1) / 2, out);
  }
}

/** A CSS gradient of the map, so a legend and the surface cannot drift apart. */
export function colormapGradient(name: ColormapName, steps = 24): string {
  if (name === "solid") return "transparent";
  const rgb: Vec3 = [0, 0, 0];
  const base: Vec3 = [0.5, 0.5, 0.5];
  const stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = -1 + (2 * i) / steps;
    colormapColor(name, t, rgb, base);
    const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);
    stops.push(`rgb(${channel(rgb[0])},${channel(rgb[1])},${channel(rgb[2])}) ${(i / steps) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
