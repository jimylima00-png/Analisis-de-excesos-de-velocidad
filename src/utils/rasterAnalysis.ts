import type { PointRow, TileMaskResult } from '../types/geo';
import { mpp, proj, ZMAX } from './geoMath';

const PROXY_TILES = '/api/tile/{z}/{x}/{y}';
const DIRECT_TILES = 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png';
const THICK = 75;
const FD = 10;

const tileCache: Record<string, Promise<TileMaskResult> | undefined> = {};
export const tileData: Record<string, TileMaskResult | undefined> = {};

let cv: HTMLCanvasElement | null = null;
let OFFS: Int32Array | null = null;

const hist = new Uint32Array(262144);
const qBuf = new Int32Array(65536);
const seen = new Uint8Array(65536);
const cand = new Uint8Array(65536);
const core = new Uint8Array(65536);
const thick = new Uint8Array(65536);
const fm = new Uint8Array(65536);

export function clearRasterCache(): void {
  Object.keys(tileCache).forEach((k) => delete tileCache[k]);
  Object.keys(tileData).forEach((k) => delete tileData[k]);
}

function sameRoadColor(d: Uint8ClampedArray, p1: number, p2: number): boolean {
  const i1 = p1 * 4;
  const i2 = p2 * 4;
  return (
    Math.abs(d[i1] - d[i2]) <= 24 &&
    Math.abs(d[i1 + 1] - d[i2 + 1]) <= 24 &&
    Math.abs(d[i1 + 2] - d[i2 + 2]) <= 24
  );
}

// Bridges text labels ("Carretera Panamericana Sur") and route shields ("PE-1S") inside road fills
// across horizontal, vertical, and both diagonal axes when both sides share the same road color.
function closeGaps(bits: Uint8Array, d: Uint8ClampedArray): void {
  const add = new Uint8Array(8192);
  const GAP = 18;
  const has = (i: number) => (bits[i >> 3] >> (i & 7)) & 1;
  const put = (i: number) => {
    add[i >> 3] |= 1 << (i & 7);
  };

  const scanLine = (x0: number, y0: number, dx: number, dy: number) => {
    let last = -1;
    let lastStep = -1;
    let x = x0;
    let y = y0;
    let step = 0;
    while (x >= 0 && x < 256 && y >= 0 && y < 256) {
      const idx = (y << 8) | x;
      if (has(idx)) {
        if (last >= 0 && step - lastStep > 1 && step - lastStep - 1 <= GAP && sameRoadColor(d, last, idx)) {
          let cx = x0 + (lastStep + 1) * dx;
          let cy = y0 + (lastStep + 1) * dy;
          for (let s = lastStep + 1; s < step; s++) {
            put((cy << 8) | cx);
            cx += dx;
            cy += dy;
          }
        }
        last = idx;
        lastStep = step;
      }
      x += dx;
      y += dy;
      step++;
    }
  };

  // Horizontal & Vertical
  for (let y = 0; y < 256; y++) scanLine(0, y, 1, 0);
  for (let x = 0; x < 256; x++) scanLine(x, 0, 0, 1);

  // Diagonal (\)
  for (let x = 0; x < 256; x++) scanLine(x, 0, 1, 1);
  for (let y = 1; y < 256; y++) scanLine(0, y, 1, 1);

  // Anti-diagonal (/)
  for (let x = 0; x < 256; x++) scanLine(x, 0, -1, 1);
  for (let y = 1; y < 256; y++) scanLine(255, y, -1, 1);

  for (let p = 0; p < 8192; p++) bits[p] |= add[p];

  // Fill small enclosed holes (e.g. route shields like PE-1S or letter interiors)
  seen.fill(0);
  const hasNow = (i: number) => (bits[i >> 3] >> (i & 7)) & 1;
  for (let i = 0; i < 65536; i++) {
    if (hasNow(i) || seen[i]) continue;
    let head = 0;
    let tail = 0;
    let touchesBorder = false;
    qBuf[tail++] = i;
    seen[i] = 1;

    while (head < tail) {
      const c = qBuf[head++];
      const cx = c & 255;
      const cy = c >> 8;
      if (cx === 0 || cx === 255 || cy === 0 || cy === 255) touchesBorder = true;

      let n: number;
      if (cx > 0 && !hasNow((n = c - 1)) && !seen[n]) {
        seen[n] = 1;
        qBuf[tail++] = n;
      }
      if (cx < 255 && !hasNow((n = c + 1)) && !seen[n]) {
        seen[n] = 1;
        qBuf[tail++] = n;
      }
      if (cy > 0 && !hasNow((n = c - 256)) && !seen[n]) {
        seen[n] = 1;
        qBuf[tail++] = n;
      }
      if (cy < 255 && !hasNow((n = c + 256)) && !seen[n]) {
        seen[n] = 1;
        qBuf[tail++] = n;
      }
    }

    if (!touchesBorder && tail <= 1500) {
      for (let k = 0; k < tail; k++) {
        const pp = qBuf[k];
        bits[pp >> 3] |= 1 << (pp & 7);
      }
    }
  }
}

function buildMask(img: HTMLImageElement): TileMaskResult {
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 256;
  }
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { err: 'cors' };

  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(img, 0, 0, 256, 256);
  const d = ctx.getImageData(0, 0, 256, 256).data;

  let best = 0;
  let bestKey = 0;
  hist.fill(0);

  for (let i = 0; i < 65536; i++) {
    const k = ((d[i * 4] >> 2) << 12) | ((d[i * 4 + 1] >> 2) << 6) | (d[i * 4 + 2] >> 2);
    if (++hist[k] > best) {
      best = hist[k];
      bestKey = k;
    }
  }

  let Lr = 0;
  let Lg = 0;
  let Lb = 0;
  for (let i = 0; i < 65536; i++) {
    const k = ((d[i * 4] >> 2) << 12) | ((d[i * 4 + 1] >> 2) << 6) | (d[i * 4 + 2] >> 2);
    if (k === bestKey) {
      Lr = d[i * 4];
      Lg = d[i * 4 + 1];
      Lb = d[i * 4 + 2];
      break;
    }
  }

  const out: TileMaskResult = { bits: new Uint8Array(8192), placeholder: false };
  if (best / 65536 > 0.9 && Math.max(Lr, Lg, Lb) - Math.min(Lr, Lg, Lb) <= 3) {
    out.placeholder = true;
    return out;
  }

  cand.fill(0);
  core.fill(0);
  thick.fill(0);
  fm.fill(0);

  for (let i = 0; i < 65536; i++) {
    const r = d[i * 4];
    const g = d[i * 4 + 1];
    const b = d[i * 4 + 2];
    const dr = r - Lr;
    const dg = g - Lg;
    const db = b - Lb;
    if (dr * dr + dg * dg + db * db < 49) continue;

    // Solo carreteras OSM (verde: autopista/troncal, rojo/salmón/naranja: troncal/primaria).
    // Se excluyen explícitamente las calles urbanas blancas o grises de pueblos/ciudades.
    const isHighwayGreen = g - Math.max(r, b) >= 16 && g >= 135;
    const isHighwayRed = r - Math.max(g, b) >= 22 && r >= 165 && g >= 60 && b >= 60;
    if (isHighwayGreen || isHighwayRed) {
      cand[i] = 1;
    }
  }

  let nCore = 0;
  for (let i = 0; i < 65536; i++) {
    if (!cand[i]) continue;
    const x = i & 255;
    const y = i >> 8;
    let ok = 1;
    const r0 = d[i * 4];
    const g0 = d[i * 4 + 1];
    const b0 = d[i * 4 + 2];

    for (let yy = Math.max(0, y - 2); ok && yy <= Math.min(255, y + 2); yy++) {
      for (let xx = Math.max(0, x - 2); xx <= Math.min(255, x + 2); xx++) {
        const p = ((yy << 8) | xx) * 4;
        if (Math.abs(d[p] - r0) > FD || Math.abs(d[p + 1] - g0) > FD || Math.abs(d[p + 2] - b0) > FD) {
          ok = 0;
          break;
        }
      }
    }
    core[i] = ok;
    nCore += ok;
  }

  if (nCore >= THICK * THICK) {
    const integral = new Int32Array(257 * 257);
    const full = THICK * THICK;
    for (let y = 0; y < 256; y++) {
      let row = 0;
      for (let x = 0; x < 256; x++) {
        row += core[(y << 8) | x];
        integral[(y + 1) * 257 + x + 1] = integral[y * 257 + x + 1] + row;
      }
    }

    for (let y0 = 0; y0 + THICK <= 256; y0 += 3) {
      for (let x0 = 0; x0 + THICK <= 256; x0 += 3) {
        const sum =
          integral[(y0 + THICK) * 257 + x0 + THICK] -
          integral[y0 * 257 + x0 + THICK] -
          integral[(y0 + THICK) * 257 + x0] +
          integral[y0 * 257 + x0];
        if (sum < full) continue;
        const seed = ((y0 + (THICK >> 1)) << 8) | (x0 + (THICK >> 1));
        if (thick[seed]) continue;
        let head = 0;
        let tail = 0;
        qBuf[tail++] = seed;
        thick[seed] = 1;
        while (head < tail) {
          const q = qBuf[head++];
          const qx = q & 255;
          const qy = q >> 8;
          for (let t = 0; t < 4; t++) {
            let nb = -1;
            if (t === 0) {
              if (qx === 0) continue;
              nb = q - 1;
            } else if (t === 1) {
              if (qx === 255) continue;
              nb = q + 1;
            } else if (t === 2) {
              if (qy === 0) continue;
              nb = q - 256;
            } else {
              if (qy === 255) continue;
              nb = q + 256;
            }
            if (!core[nb] || thick[nb]) continue;
            if (
              Math.abs(d[nb * 4] - d[q * 4]) > FD ||
              Math.abs(d[nb * 4 + 1] - d[q * 4 + 1]) > FD ||
              Math.abs(d[nb * 4 + 2] - d[q * 4 + 2]) > FD
            )
              continue;
            thick[nb] = 1;
            qBuf[tail++] = nb;
          }
        }
      }
    }
  }

  for (let i = 0; i < 65536; i++) fm[i] = core[i] && !thick[i] ? 1 : 0;

  seen.fill(0);
  for (let i = 0; i < 65536; i++) {
    if (!cand[i] || fm[i] || thick[i]) continue;
    const x = i & 255;
    const y = i >> 8;
    let ok = 0;
    for (let yy = Math.max(0, y - 2); !ok && yy <= Math.min(255, y + 2); yy++) {
      for (let xx = Math.max(0, x - 2); xx <= Math.min(255, x + 2); xx++) {
        const p = (yy << 8) | xx;
        if (!fm[p]) continue;
        if (
          Math.abs(d[p * 4] - d[i * 4]) <= FD &&
          Math.abs(d[p * 4 + 1] - d[i * 4 + 1]) <= FD &&
          Math.abs(d[p * 4 + 2] - d[i * 4 + 2]) <= FD
        ) {
          ok = 1;
          break;
        }
      }
    }
    if (ok) seen[i] = 1;
  }
  for (let i = 0; i < 65536; i++) if (seen[i]) fm[i] = 1;

  seen.fill(0);
  for (let i = 0; i < 65536; i++) {
    if (!fm[i] || seen[i]) continue;
    let h2 = 0;
    let t2 = 0;
    qBuf[t2++] = i;
    seen[i] = 1;
    while (h2 < t2) {
      const c = qBuf[h2++];
      const cx = c & 255;
      const cy = c >> 8;
      let n: number;
      if (cx > 0 && fm[(n = c - 1)] && !seen[n]) {
        seen[n] = 1;
        qBuf[t2++] = n;
      }
      if (cx < 255 && fm[(n = c + 1)] && !seen[n]) {
        seen[n] = 1;
        qBuf[t2++] = n;
      }
      if (cy > 0 && fm[(n = c - 256)] && !seen[n]) {
        seen[n] = 1;
        qBuf[t2++] = n;
      }
      if (cy < 255 && fm[(n = c + 256)] && !seen[n]) {
        seen[n] = 1;
        qBuf[t2++] = n;
      }
    }
    if (t2 >= 30 && out.bits) {
      for (let z2 = 0; z2 < t2; z2++) {
        const pp = qBuf[z2];
        out.bits[pp >> 3] |= 1 << (pp & 7);
      }
    }
  }

  if (out.bits) closeGaps(out.bits, d);
  return out;
}

export function loadTile(z: number, x: number, y: number): Promise<TileMaskResult> {
  const key = `${z}/${x}/${y}`;
  if (tileCache[key]) return tileCache[key];

  const isFileProtocol = typeof window !== 'undefined' && window.location.protocol === 'file:';
  const formatUrl = (tpl: string) =>
    tpl
      .replace('{s}', 'abc'.charAt(Math.abs(x + y) % 3))
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));

  tileCache[key] = new Promise((resolve) => {
    const done = (v: TileMaskResult) => {
      tileData[key] = v;
      resolve(v);
    };

    const loadFromUrl = (url: string, onFail?: () => void) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          done(buildMask(img));
        } catch {
          if (onFail) onFail();
          else done({ err: 'cors' });
        }
      };
      img.onerror = () => {
        if (onFail) onFail();
        else done({ err: 'load' });
      };
      img.src = url;
    };

    if (isFileProtocol) {
      loadFromUrl(formatUrl(DIRECT_TILES));
    } else {
      loadFromUrl(formatUrl(PROXY_TILES), () => loadFromUrl(formatUrl(DIRECT_TILES)));
    }
  });

  return tileCache[key];
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        await fn(items[i++]);
      }
    })
  );
}

async function probeZoom(rows: PointRow[], signal?: AbortSignal): Promise<number | null> {
  const v = rows.filter((r) => r.valid);
  if (!v.length) return null;
  const smp = [v[0], v[Math.floor(v.length / 2)], v[v.length - 1]];
  for (let z = ZMAX; z >= 16; z--) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let ok = 0;
    for (let i = 0; i < smp.length; i++) {
      const P = proj(smp[i].lat, smp[i].lon, z);
      const res = await loadTile(z, Math.floor(P[0] / 256), Math.floor(P[1] / 256));
      if (!res.err && !res.placeholder) ok++;
    }
    if (ok >= 2) return z;
  }
  return null;
}

function buildOffsets(): void {
  const a: [number, number, number][] = [];
  const R = 90;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 <= R * R) a.push([dx, dy, d2]);
    }
  }
  a.sort((p, q) => p[2] - q[2]);
  OFFS = new Int32Array(a.length * 3);
  a.forEach((t, i) => {
    OFFS![i * 3] = t[0];
    OFFS![i * 3 + 1] = t[1];
    OFFS![i * 3 + 2] = t[2];
  });
}

function computeRasterDistances(rows: PointRow[], z: number): void {
  if (!OFFS) buildOffsets();
  rows.forEach((r) => {
    r.dist = null;
    r.excess = null;
    if (!r.valid) return;

    const cx = Math.floor(r.x);
    const cy = Math.floor(r.y);
    const tx0 = (cx >> 8) - 1;
    const ty0 = (cy >> 8) - 1;
    const g: (Uint8Array | null)[] = [];

    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        const t = tileData[`${z}/${tx0 + i}/${ty0 + j}`];
        g.push(t && t.bits ? t.bits : null);
      }
    }

    const R2 = r.R * r.R;
    let found = -1;
    let bestD = Infinity;
    let lim = Infinity;

    for (let o = 0; o < OFFS!.length; o += 3) {
      const d2 = OFFS![o + 2];
      if (d2 > lim) break;
      if (found < 0 && d2 > R2) break;
      const xx = cx + OFFS![o];
      const yy = cy + OFFS![o + 1];
      const bits = g[((yy >> 8) - ty0) * 3 + ((xx >> 8) - tx0)];
      if (!bits) continue;
      const idx = ((yy & 255) << 8) | (xx & 255);
      if (bits[idx >> 3] & (1 << (idx & 7))) {
        const ex = Math.max(Math.abs(xx + 0.5 - r.x) - 0.5, 0);
        const ey = Math.max(Math.abs(yy + 0.5 - r.y) - 0.5, 0);
        const dd = Math.sqrt(ex * ex + ey * ey);
        if (dd < bestD) bestD = dd;
        if (found < 0) {
          found = d2;
          lim = Math.pow(Math.sqrt(d2) + 2, 2);
        }
      }
    }

    if (found >= 0) {
      r.dist = bestD;
      r.excess = bestD;
      r.rasterDist = bestD;
      r.rasterExcessPx = bestD;
    } else {
      r.rasterDist = null;
      r.rasterExcessPx = null;
    }
  });
}

export async function runRasterAnalysis(
  rows: PointRow[],
  onProgress: (pct: number, msg: string) => void,
  signal?: AbortSignal
): Promise<{ usedZoom: number }> {
  onProgress(5, 'Buscando zoom máximo con imágenes del mapa en la zona…');
  const zProbe = await probeZoom(rows, signal);
  if (zProbe == null) {
    throw new Error('NO_TILES');
  }

  let used = zProbe;
  let bad = 0;
  let total = 0;

  for (let z = zProbe; z >= 16; z--) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const validRows = rows.filter((r) => r.valid);
    const need: Record<string, number> = {};
    const list: [number, number][] = [];

    validRows.forEach((r) => {
      const P = proj(r.lat, r.lon, z);
      r.x = P[0];
      r.y = P[1];
      r.mpp = mpp(r.lat, z);
      r.R = Math.min(90, Math.ceil(25 / r.mpp));
      const x0 = Math.floor((r.x - r.R) / 256);
      const x1 = Math.floor((r.x + r.R) / 256);
      const y0 = Math.floor((r.y - r.R) / 256);
      const y1 = Math.floor((r.y + r.R) / 256);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const k = `${z}/${tx}/${ty}`;
          if (!need[k]) {
            need[k] = 1;
            list.push([tx, ty]);
          }
        }
      }
    });

    let done = 0;
    bad = 0;
    total = list.length;

    await pool(
      list,
      8,
      async (t) => {
        const res = await loadTile(z, t[0], t[1]);
        done++;
        if (res.err || res.placeholder) bad++;
        const pct = Math.round((done / total) * 90);
        onProgress(pct, `Leyendo dibujo del mapa (zoom ${z})… ${done} de ${total} teselas`);
      },
      signal
    );

    used = z;
    if (bad <= total * 0.2) break;
  }

  if (bad > total * 0.2) {
    throw new Error('El mapa no tiene imágenes disponibles en esta zona.');
  }

  onProgress(95, 'Midiendo distancia subpíxel al trazo de la vía…');
  await new Promise((r) => setTimeout(r, 20));
  computeRasterDistances(rows, used);
  return { usedZoom: used };
}
