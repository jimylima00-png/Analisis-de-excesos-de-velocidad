import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import type { DatasetState, FilterStatus, OsmWay, PointRow, RoadGroup } from '../types/geo';
import { getConfidenceLabel, isEffectiveInside, mpp, ZMAX } from '../utils/geoMath';
import { GROUP_COLOR } from '../utils/overpassAnalysis';
import { tileData } from '../utils/rasterAnalysis';

interface MapPanelProps {
  state: DatasetState;
  filterStatus: FilterStatus;
  searchQuery: string;
  showRoads: boolean;
  showMask: boolean;
  showLabels: boolean;
  clusterPoints: boolean;
  enabledGroups: Record<RoadGroup, boolean>;
  selectedPointId: number | null;
  selectedPlate: string;
  minSpeedKmh: number;
  showTrajectory: boolean;
  analyzing: boolean;
  progressMsg: string;
  progressPct: number;
  fitTrigger: number;
  onSelectPoint: (id: number) => void;
  onCancelAnalysis: () => void;
}

const iconCache: Record<string, L.DivIcon> = {};
function getPinIcon(color: string, isOverridden: boolean): L.DivIcon {
  const key = `${color}_${isOverridden ? '1' : '0'}`;
  if (!iconCache[key]) {
    const ring = isOverridden ? '<circle cx="14" cy="13.8" r="8.2" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-dasharray="2 2"/>' : '';
    iconCache[key] = L.divIcon({
      className: 'arrow-ic',
      iconSize: [22, 32],
      iconAnchor: [11, 32],
      popupAnchor: [0, -30],
      tooltipAnchor: [0, -30],
      html: `<svg width="22" height="32" viewBox="0 0 28 40"><path d="M14 .8C6.5.8.8 6.7.8 13.6c0 5 2.5 9 4.9 12.6C8.6 30.7 14 39.2 14 39.2s5.4-8.5 8.3-13c2.4-3.6 4.9-7.6 4.9-12.6C27.2 6.7 21.5.8 14 .8z" fill="${color}" stroke="rgba(0,0,0,.38)" stroke-width="1.4"/>${ring}<circle cx="14" cy="13.8" r="5" fill="#fff"/></svg>`,
    });
  }
  return iconCache[key];
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function buildPopupHtml(r: PointRow, state: DatasetState): string {
  let rows = '';
  state.header.forEach((h, i) => {
    if (h.toLowerCase() === 'mapa' || r.d[i] === '') return;
    rows += `<tr><td style="padding:2px 10px 2px 0;color:#64748b">${esc(h)}</td><td style="font-weight:600;color:#0f172a">${esc(r.d[i])}</td></tr>`;
  });

  let extra = '';
  if (state.analyzed) {
    const effIn = isEffectiveInside(r);
    const statusText = r.manualOverride
      ? `${effIn ? 'Dentro' : 'Fuera'} (revisión manual)`
      : effIn
      ? r.rescued
        ? 'Dentro (ajustado por vecindad)'
        : 'Dentro de carretera'
      : 'Fuera de carretera';

    const lab = (a: string, b: string) =>
      `<tr><td style="padding:3px 10px 1px 0;color:#64748b">${a}</td><td style="font-weight:600;color:#0f172a">${b}</td></tr>`;

    if (state.mode === 'esri') {
      extra =
        lab('Resultado', statusText) +
        lab('Confianza', getConfidenceLabel(r.confidence)) +
        (r.dist != null
          ? lab(`Distancia a franja (z${state.zA})`, `${r.dist.toFixed(1)} px · ${(r.dist * r.mpp).toFixed(2)} m`)
          : lab('Franja de vía', `Ninguna a ≤ ${Math.round(r.R * r.mpp)} m`));
    } else if (r.dist != null && r.wayObj) {
      const dm = r.dist * r.mpp;
      extra =
        lab('Resultado', statusText) +
        lab('Confianza', getConfidenceLabel(r.confidence)) +
        lab(`Distancia al eje (z${ZMAX})`, `${Math.round(r.dist)} px · ${dm.toFixed(1)} m`) +
        lab('Semiancho vía', `${Math.round(r.half / r.mpp)} px · ${r.half.toFixed(1)} m`) +
        (r.wayObj.maxspeed != null
          ? lab(
              'Límite vía OSM',
              `${r.wayObj.maxspeed} km/h${r.speedKmh != null && r.speedKmh > r.wayObj.maxspeed ? ` (Exceso +${Math.round(r.speedKmh - r.wayObj.maxspeed)} km/h)` : ''}`
            )
          : '') +
        lab(
          'Vía OSM',
          `${esc(r.wayObj.name || 'sin nombre')} · ${esc(r.wayObj.kind)} · <a href="https://www.openstreetmap.org/way/${r.wayObj.id}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:underline">ver</a>`
        );
    } else {
      extra = lab('Resultado', statusText) + lab('Vía OSM', 'Sin vía cercana (≤ 60 m)');
    }
  }

  return `<table style="font-size:12px;border-collapse:collapse;font-family:'Plus Jakarta Sans',sans-serif">${rows}${extra}</table>`;
}

export function MapPanel({
  state,
  filterStatus,
  searchQuery,
  showRoads,
  showMask,
  showLabels,
  clusterPoints,
  enabledGroups,
  selectedPointId,
  selectedPlate,
  minSpeedKmh,
  showTrajectory,
  analyzing,
  progressMsg,
  progressPct,
  fitTrigger,
  onSelectPoint,
  onCancelAnalysis,
}: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | L.MarkerClusterGroup | null>(null);
  const trajectoryLayerRef = useRef<L.LayerGroup | null>(null);
  const roadsLayerRef = useRef<L.LayerGroup | null>(null);
  const maskLayerRef = useRef<L.GridLayer | null>(null);
  const highlightLayerRef = useRef<L.Polyline | null>(null);
  const markerByIdRef = useRef<Record<number, L.Marker>>({});
  const roadLinesRef = useRef<Array<{ way: OsmWay; pl: L.Polyline }>>([]);

  // Initialize Leaflet map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, { maxZoom: ZMAX });
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
      subdomains: 'abc',
      maxZoom: ZMAX,
      attribution: '&copy; OpenStreetMap contributors · OSM France',
    });
    const sat = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: ZMAX, attribution: 'Tiles &copy; Esri' }
    );

    osm.addTo(map);
    L.control.layers({ OpenStreetMap: osm, 'Satélite (visual)': sat }, undefined, { position: 'topright' }).addTo(map);
    map.setView([-12.05, -77.04], 8);

    map.on('zoomend', () => {
      const z = map.getZoom();
      roadLinesRef.current.forEach(({ way, pl }) => {
        pl.setStyle({ weight: Math.max(2, (2 * way.half) / mpp(way.lat, z)) });
      });
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Draw markers whenever data/filters/options change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (markersLayerRef.current) {
      map.removeLayer(markersLayerRef.current);
      markersLayerRef.current = null;
    }
    markerByIdRef.current = {};

    const clearHighlight = () => {
      if (highlightLayerRef.current) {
        map.removeLayer(highlightLayerRef.current);
        highlightLayerRef.current = null;
      }
    };

    const group = clusterPoints
      ? L.markerClusterGroup({
          maxClusterRadius: 30,
          spiderfyOnMaxZoom: true,
          showCoverageOnHover: false,
          chunkedLoading: true,
          spiderLegPolylineOptions: { weight: 1.5, color: '#64748b', opacity: 0.7 },
        })
      : L.layerGroup();

    const q = searchQuery.trim().toLowerCase();
    const bounds: [number, number][] = [];
    const markers: L.Marker[] = [];
    const byPlate: Record<string, [number, number][]> = {};

    state.rows.forEach((r) => {
      if (!r.valid) return;
      if (selectedPlate && r.plate !== selectedPlate) return;
      if (minSpeedKmh > 0 && r.speedKmh != null && r.speedKmh < minSpeedKmh) return;

      const effIn = isEffectiveInside(r);

      if (state.analyzed) {
        if (filterStatus === 'in' && !effIn) return;
        if (filterStatus === 'out' && effIn) return;
        if (filterStatus === 'doubtful' && r.confidence !== 'dudosa') return;
        if (filterStatus === 'overridden' && r.manualOverride === null) return;
      }

      if (q) {
        const hay = `${r.plate} ${r.road} ${r.id}`.toLowerCase();
        if (!hay.includes(q)) return;
      }

      if (r.plate) {
        if (!byPlate[r.plate]) byPlate[r.plate] = [];
        byPlate[r.plate].push([r.lat, r.lon]);
      }

      const color = !state.analyzed ? '#2563eb' : effIn ? '#16a34a' : '#dc2626';
      const marker = L.marker([r.lat, r.lon], {
        icon: getPinIcon(color, r.manualOverride !== null),
        riseOnHover: true,
      });

      marker.bindPopup(() => buildPopupHtml(r, state), { maxWidth: 360 });
      marker.on('popupopen', () => {
        onSelectPoint(r.id);
        clearHighlight();
        if (r.wayObj) {
          highlightLayerRef.current = L.polyline(r.wayObj.pts, {
            color: '#d946ef',
            weight: 5,
            opacity: 0.9,
            interactive: false,
          }).addTo(map);
        }
      });
      marker.on('popupclose', clearHighlight);

      if (r.plate) {
        marker.bindTooltip(esc(r.plate), {
          permanent: showLabels,
          direction: 'top',
          offset: [0, 0],
          className: 'mat-tooltip',
        });
      }

      markerByIdRef.current[r.id] = marker;
      markers.push(marker);
      bounds.push([r.lat, r.lon]);
    });

    if ('addLayers' in group && typeof group.addLayers === 'function') {
      group.addLayers(markers);
    } else {
      markers.forEach((m) => group.addLayer(m));
    }

    group.addTo(map);
    markersLayerRef.current = group;

    if (trajectoryLayerRef.current) {
      map.removeLayer(trajectoryLayerRef.current);
      trajectoryLayerRef.current = null;
    }
    if (showTrajectory) {
      const tg = L.layerGroup();
      Object.values(byPlate).forEach((pts) => {
        if (pts.length >= 2) {
          L.polyline(pts, {
            color: '#2563eb',
            weight: 2.5,
            opacity: 0.7,
            dashArray: '6 5',
            interactive: false,
          }).addTo(tg);
        }
      });
      tg.addTo(map);
      trajectoryLayerRef.current = tg;
    }

    if (fitTrigger > 0 && bounds.length) {
      map.fitBounds(bounds, { padding: [44, 44], maxZoom: 17 });
    }
  }, [
    state,
    filterStatus,
    searchQuery,
    selectedPlate,
    minSpeedKmh,
    showTrajectory,
    showLabels,
    clusterPoints,
    fitTrigger,
    onSelectPoint,
  ]);

  // Draw OSM roads overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (roadsLayerRef.current) {
      map.removeLayer(roadsLayerRef.current);
      roadsLayerRef.current = null;
    }
    roadLinesRef.current = [];

    if (!showRoads || state.mode === 'esri' || !state.ways.length) return;

    const rg = L.layerGroup();
    const z = map.getZoom();

    state.ways.forEach((w) => {
      if (!enabledGroups[w.grp]) return;
      const pl = L.polyline(w.pts, {
        color: GROUP_COLOR[w.grp],
        weight: Math.max(2, (2 * w.half) / mpp(w.lat, z)),
        opacity: 0.5,
        lineCap: 'butt',
        lineJoin: 'round',
        interactive: false,
      }).addTo(rg);
      roadLinesRef.current.push({ way: w, pl });
    });

    rg.addTo(map);
    roadsLayerRef.current = rg;
  }, [showRoads, state.ways, state.mode, enabledGroups]);

  // Draw raster mask overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (maskLayerRef.current) {
      map.removeLayer(maskLayerRef.current);
      maskLayerRef.current = null;
    }

    if (!showMask || (state.mode !== 'esri' && state.mode !== 'hybrid') || !state.analyzed) return;

    const z = state.zA;
    const MaskLayer = L.GridLayer.extend({
      createTile: (coords: L.Coords) => {
        const t = document.createElement('canvas');
        t.width = 256;
        t.height = 256;
        const d = tileData[`${z}/${coords.x}/${coords.y}`];
        if (d && d.bits) {
          const ctx = t.getContext('2d');
          if (ctx) {
            const im = ctx.createImageData(256, 256);
            const px = im.data;
            for (let i = 0; i < 65536; i++) {
              if ((d.bits[i >> 3] >> (i & 7)) & 1) {
                px[i * 4] = 217;
                px[i * 4 + 1] = 70;
                px[i * 4 + 2] = 239;
                px[i * 4 + 3] = 140;
              }
            }
            ctx.putImageData(im, 0, 0);
          }
        }
        return t;
      },
    });

    const ml = new (MaskLayer as unknown as new (opts: L.GridLayerOptions) => L.GridLayer)({
      minNativeZoom: z,
      maxNativeZoom: z,
      maxZoom: ZMAX,
      zIndex: 5,
    });
    ml.addTo(map);
    maskLayerRef.current = ml;
  }, [showMask, state.mode, state.zA, state.analyzed]);

  // Pan to selected point from table
  useEffect(() => {
    const map = mapRef.current;
    if (!map || selectedPointId == null) return;
    const marker = markerByIdRef.current[selectedPointId];
    if (marker) {
      const ll = marker.getLatLng();
      map.setView(ll, Math.max(map.getZoom(), 18), { animate: true });
      setTimeout(() => marker.openPopup(), 180);
    }
  }, [selectedPointId]);

  return (
    <div className="relative rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-100 dark:bg-slate-900">
      <div ref={containerRef} className="w-full h-[540px] z-0" />

      {analyzing && (
        <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-slate-950/35 backdrop-blur-[1px]">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-5 shadow-xl max-w-sm w-full mx-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-5 h-5 border-2 border-slate-300 dark:border-slate-700 border-t-blue-600 rounded-full animate-spin shrink-0" />
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Analizando coordenadas</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 mb-3">{progressMsg}</p>
            <div className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden mb-3">
              <div
                className="h-full bg-blue-600 transition-all duration-200"
                style={{ width: `${Math.max(4, progressPct)}%` }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono tabular-nums text-slate-500">{progressPct}%</span>
              <button
                type="button"
                onClick={onCancelAnalysis}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
