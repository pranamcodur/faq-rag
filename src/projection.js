'use strict';

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const normalize = (v) => { const n = Math.sqrt(dot(v, v)) || 1; return v.map((x) => x / n); };

/**
 * Fits a 2-component PCA with power iteration (no dependencies) so high-dimensional embeddings
 * can be drawn on a 2D map. Vectors are L2-normalised first so the geometry matches cosine similarity.
 * Deterministic: fixed start vectors and a fixed sign convention, so the map doesn't flip between reloads.
 *
 * Returns { dimensions, explained: [r1, r2], project(vec) -> [x, y] } where explained is the
 * fraction of total variance each axis keeps (how much a 2D picture can be trusted).
 */
function fitPca(vectors) {
  const n = vectors.length;
  if (n === 0) return { dimensions: 0, explained: [0, 0], project: () => [0, 0] };

  const rows = vectors.map(normalize);
  const d = rows[0].length;
  const mean = new Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j] / n;
  const X = rows.map((r) => r.map((x, j) => x - mean[j]));
  const totalVar = X.reduce((s, r) => s + dot(r, r), 0) / n;

  const comps = [];
  const explained = [];
  for (let c = 0; c < 2; c++) {
    let v = normalize(Array.from({ length: d }, (_, j) => (((j + 1) * 7919 + c * 104729) % 1009) / 1009 - 0.5));
    for (let it = 0; it < 200; it++) {
      const Xv = X.map((r) => dot(r, v));
      const w = new Array(d).fill(0);
      for (let i = 0; i < n; i++) { const a = Xv[i]; for (let j = 0; j < d; j++) w[j] += X[i][j] * a; }
      for (const u of comps) { const p = dot(w, u); for (let j = 0; j < d; j++) w[j] -= p * u[j]; } // stay orthogonal to earlier axes
      const norm = Math.sqrt(dot(w, w));
      if (norm < 1e-12) { v = new Array(d).fill(0); break; } // no variance left on this axis
      const next = w.map((x) => x / norm);
      const moved = Math.sqrt(next.reduce((s, x, j) => s + (x - v[j]) ** 2, 0));
      v = next;
      if (moved < 1e-9) break;
    }
    // sign convention: the largest-magnitude entry is positive
    let big = 0;
    for (let j = 1; j < d; j++) if (Math.abs(v[j]) > Math.abs(v[big])) big = j;
    if (v[big] < 0) v = v.map((x) => -x);
    comps.push(v);
    explained.push(totalVar > 0 ? X.reduce((s, r) => s + dot(r, v) ** 2, 0) / n / totalVar : 0);
  }

  return {
    dimensions: d,
    explained,
    project(vec) {
      const c = normalize(vec).map((x, j) => x - mean[j]);
      return [dot(c, comps[0]), dot(c, comps[1])];
    },
  };
}

module.exports = { fitPca };
