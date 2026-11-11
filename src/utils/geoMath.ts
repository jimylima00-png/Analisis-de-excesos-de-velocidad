import type { AnalysisMode, ConfidenceLevel, PointRow } from '../types/geo';

export const ZMAX = 19;
export const MAXTOL = 60;
const GRACE = 5;
const NEAR = 40;

export function mpp(lat: number, z: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
}

export function proj(lat: number, lon: number, z: number = ZMAX): [number, number] {
  const sc = 256 * Math.pow(2, z);
  const f = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return [((lon + 180) / 360) * sc, (0.5 - Math.log((1 + f) / (1 - f)) / (4 * Math.PI)) * sc];
}

export function isEffectiveInside(r: PointRow): boolean {
  if (!r.valid) return false;
  if (r.manualOverride === 'in') return true;
  if (r.manualOverride === 'out') return false;
  return r.inside;
}

export function classifyPoints(rows: PointRow[], tolMeters: number, mode: AnalysisMode): void {
  const isRasterLike = mode === 'esri';

  rows.forEach((r) => {
    r.rescued = false;
    if (!r.valid || r.excess == null) {
      r.inside = false;
      r.confidence = 'alta';
      return;
    }

    const tolPx = tolMeters / r.mpp;
    const halfPxSlack = isRasterLike ? 0.5 : 0;
    r.inside = r.excess <= tolPx + halfPxSlack;

    // Determine confidence level
    const marginMeters = (r.excess - tolPx) * r.mpp;
    if (r.inside) {
      r.confidence = marginMeters <= -1.5 ? 'alta' : 'media';
    } else {
      r.confidence = marginMeters <= 5 ? 'dudosa' : 'alta';
    }
  });

  if (mode === 'osm' || mode === 'hybrid') {
    const firm = rows.filter((r) => r.inside && r.excess != null && r.excess <= (tolMeters * 0.6) / r.mpp);
    rows.forEach((r) => {
      if (!r.valid || r.inside || r.excess == null || r.excess > (tolMeters + GRACE) / r.mpp) return;
      const near = NEAR / r.mpp;
      for (let i = 0; i < firm.length; i++) {
        const f = firm[i];
        const sameWay = f.wayId != null && f.wayId === r.wayId;
        const samePlate = Boolean(r.plate && f.plate && r.plate === f.plate);
        if (!sameWay && !samePlate) continue;
        const dx = f.x - r.x;
        const dy = f.y - r.y;
        if (dx * dx + dy * dy <= near * near) {
          r.inside = true;
          r.rescued = true;
          r.confidence = sameWay ? 'media' : 'dudosa';
          break;
        }
      }
    });
  }

  if (mode === 'hybrid') {
    rows.forEach((r) => {
      if (!r.valid) return;
      if (r.rasterInside !== undefined && r.osmInside !== undefined) {
        if (r.rasterInside && r.osmInside) {
          r.inside = true;
          r.confidence = 'alta';
        } else if (!r.rasterInside && !r.osmInside) {
          r.inside = false;
          r.confidence = 'alta';
        } else {
          const osmEx = r.osmExcessMeters;
          if (r.rasterInside && osmEx != null && osmEx <= tolMeters + 3.0) {
            r.inside = true;
            r.confidence = 'media';
          } else if (osmEx == null || osmEx > tolMeters + 12) {
            // Raster likely hit a white building/plaza far from any OSM road
            r.inside = false;
            r.confidence = 'dudosa';
          } else {
            r.inside = r.osmInside;
            r.confidence = 'dudosa';
          }
        }
      }
    });
  }
}

export function getConfidenceLabel(c: ConfidenceLevel): string {
  if (c === 'alta') return 'Alta';
  if (c === 'media') return 'Media';
  return 'Dudosa';
}
