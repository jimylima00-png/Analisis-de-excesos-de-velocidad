import type { DatasetState, OsmWay, PointRow, RoadGroup } from '../types/geo';
import { MAXTOL, mpp, proj, ZMAX } from './geoMath';

const CELL = 0.003;
const CHUNK = 40;
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];
const EXCL =
  'footway|path|steps|cycleway|pedestrian|bridleway|corridor|platform|proposed|construction|raceway|elevator';

export const GROUP_COLOR: Record<RoadGroup, string> = {
  main: '#f59e0b',
  sec: '#ca8a04',
  local: '#0ea5e9',
  svc: '#6b7280',
};

const GROUPS: Record<Exclude<RoadGroup, 'svc'>, string[]> = {
  main: ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'],
  sec: ['secondary', 'secondary_link', 'tertiary', 'tertiary_link'],
  local: ['unclassified', 'residential', 'living_street', 'road'],
};

const HALF: Record<string, number> = {
  motorway: 7,
  motorway_link: 4.5,
  trunk: 6.5,
  trunk_link: 4.5,
  primary: 5.5,
  primary_link: 4,
  secondary: 4.5,
  secondary_link: 4,
  tertiary: 4,
  tertiary_link: 3.5,
  unclassified: 3.5,
  residential: 3.5,
  living_street: 3,
  service: 2.5,
  track: 2,
};

function grpOf(kind: string): RoadGroup {
  if (GROUPS.main.includes(kind)) return 'main';
  if (GROUPS.sec.includes(kind)) return 'sec';
  if (GROUPS.local.includes(kind)) return 'local';
  return 'svc';
}

function halfWidth(tg: Record<string, string>): number {
  const w = parseFloat(String(tg.width || '').replace(',', '.'));
  if (Number.isFinite(w) && w > 0 && w < 60) return w / 2;
  const l = parseInt(tg.lanes, 10);
  if (Number.isFinite(l) && l > 0 && l < 12) return (l * 3.5) / 2;
  const base = HALF[tg.highway] || 3.5;
  if (tg.oneway === 'yes' && (tg.highway === 'primary' || tg.highway === 'secondary' || tg.highway === 'trunk')) {
    return base * 0.78;
  }
  return base;
}

interface OverpassElement {
  type: string;
  id: number;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

async function overpassQuery(query: string, signal?: AbortSignal): Promise<OverpassElement[]> {
  const isFileProtocol = typeof window !== 'undefined' && window.location.protocol === 'file:';

  // Primary path when hosted: server-side proxy avoids browser CORS and rate-limit failures
  if (!isFileProtocol) {
    try {
      const res = await fetch('/api/overpass', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: query }),
      });
      if (res.ok) {
        const js = await res.json();
        return (js.elements as OverpassElement[]) || [];
      }
    } catch {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
  }

  // Direct fallback if proxy is unavailable
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let i = 0; i < ENDPOINTS.length; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const to = setTimeout(() => ctl.abort(), 90000);

      try {
        const res = await fetch(ENDPOINTS[i], {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        clearTimeout(to);
        signal?.removeEventListener('abort', onAbort);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const js = await res.json();
        return (js.elements as OverpassElement[]) || [];
      } catch (e) {
        clearTimeout(to);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        lastErr = e;
      }
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }

  throw lastErr instanceof Error ? lastErr : new Error('Sin respuesta de Overpass');
}

export function computeOsmDistances(
  rows: PointRow[],
  ways: OsmWay[],
  enabledGroups: Record<RoadGroup, boolean>
): void {
  rows.forEach((r) => {
    r.dist = null;
    r.excess = null;
    r.road = '';
    r.wayId = null;
    r.half = 0;
    r.wayObj = null;
    if (!r.valid) return;

    const P = proj(r.lat, r.lon, ZMAX);
    const m = mpp(r.lat, ZMAX);
    r.x = P[0];
    r.y = P[1];
    r.mpp = m;

    const kx = 111320 * Math.cos((r.lat * Math.PI) / 180);
    const ky = 110574;
    const padLat = MAXTOL / ky;
    const padLon = MAXTOL / kx;
    const maxPx = MAXTOL / m;

    let bestEx = Infinity;
    let bestD = Infinity;
    let bestWay: OsmWay | null = null;

    for (let w = 0; w < ways.length; w++) {
      const W = ways[w];
      if (!enabledGroups[W.grp]) continue;
      const bb = W.bb;
      if (r.lat < bb[0] - padLat || r.lat > bb[1] + padLat || r.lon < bb[2] - padLon || r.lon > bb[3] + padLon) {
        continue;
      }
      const pp = W.pp;
      const halfPx = W.half / m;

      for (let i = 0; i < pp.length - 1; i++) {
        const ax = pp[i][0] - P[0];
        const ay = pp[i][1] - P[1];
        const dx = pp[i + 1][0] - pp[i][0];
        const dy = pp[i + 1][1] - pp[i][1];
        const l2 = dx * dx + dy * dy;
        let t = 0;
        if (l2 > 0) {
          t = -(ax * dx + ay * dy) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
        }
        const px = ax + t * dx;
        const py = ay + t * dy;
        const dist = Math.sqrt(px * px + py * py);
        if (dist > maxPx) continue;
        const ex = dist - halfPx;
        if (ex < bestEx) {
          bestEx = ex;
          bestD = dist;
          bestWay = W;
        }
      }
    }

    if (bestWay) {
      r.dist = bestD;
      r.excess = bestEx;
      r.wayId = bestWay.id;
      r.half = bestWay.half;
      r.wayObj = bestWay;
      r.road = bestWay.name || bestWay.kind;
      r.osmDist = bestD;
      r.osmExcessMeters = bestEx * m;
    } else {
      r.osmDist = null;
      r.osmExcessMeters = null;
    }
  });
}

export async function runOsmAnalysis(
  state: DatasetState,
  enabledGroups: Record<RoadGroup, boolean>,
  onProgress: (pct: number, msg: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const cells: Record<string, [number, number]> = {};
  state.rows.forEach((r) => {
    if (!r.valid) return;
    const a = Math.floor(r.lat / CELL);
    const b = Math.floor(r.lon / CELL);
    cells[`${a}_${b}`] = [a, b];
  });

  const keys = Object.keys(cells);
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += CHUNK) chunks.push(keys.slice(i, i + CHUNK));

  for (let ci = 0; ci < chunks.length; ci++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (state.done[ci]) continue;

    const pct = Math.round((ci / Math.max(1, chunks.length)) * 90);
    onProgress(pct, `Consultando carreteras OpenStreetMap… lote ${ci + 1} de ${chunks.length}`);

    const parts = chunks[ci].map((k) => {
      const [a, b] = cells[k];
      const midLat = (a + 0.5) * CELL;
      const dLat = MAXTOL / 110574 + 1e-5;
      const dLon = MAXTOL / (111320 * Math.cos((midLat * Math.PI) / 180)) + 1e-5;
      const bb = [a * CELL - dLat, b * CELL - dLon, (a + 1) * CELL + dLat, (b + 1) * CELL + dLon]
        .map((x) => x.toFixed(6))
        .join(',');
      return `way["highway"]["highway"!~"^(${EXCL})$"](${bb});`;
    });

    const q = `[out:json][timeout:90];(${parts.join('')});out geom;`;
    const els = await overpassQuery(q, signal);

    els.forEach((el) => {
      if (el.type !== 'way' || !el.geometry || state.wayIds[el.id]) return;
      state.wayIds[el.id] = 1;
      const pts: [number, number][] = el.geometry.map((g) => [g.lat, g.lon]);
      let mnLa = 90;
      let mxLa = -90;
      let mnLo = 180;
      let mxLo = -180;
      pts.forEach((p) => {
        if (p[0] < mnLa) mnLa = p[0];
        if (p[0] > mxLa) mxLa = p[0];
        if (p[1] < mnLo) mnLo = p[1];
        if (p[1] > mxLo) mxLo = p[1];
      });
      const tg = el.tags || {};
      const kind = tg.highway || '';
      const msMatch = String(tg.maxspeed || '').match(/\d+/);
      const maxspeed = msMatch ? parseInt(msMatch[0], 10) : null;
      state.ways.push({
        id: el.id,
        pts,
        pp: pts.map((pt) => proj(pt[0], pt[1], ZMAX)),
        lat: (mnLa + mxLa) / 2,
        bb: [mnLa, mxLa, mnLo, mxLo],
        name: tg.name || tg.ref || '',
        kind,
        grp: grpOf(kind),
        half: halfWidth(tg),
        maxspeed: maxspeed && maxspeed > 0 && maxspeed <= 200 ? maxspeed : null,
      });
    });

    state.done[ci] = true;
  }

  onProgress(95, 'Calculando distancia de cada coordenada a las vías…');
  await new Promise((r) => setTimeout(r, 20));
  computeOsmDistances(state.rows, state.ways, enabledGroups);
}
