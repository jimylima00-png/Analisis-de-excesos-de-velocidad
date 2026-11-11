import * as XLSX from 'xlsx';
import type { ColumnMapping, DatasetState, PointRow } from '../types/geo';
import { getConfidenceLabel, isEffectiveInside } from './geoMath';

export function normHeader(s: unknown): string {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseCoord(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  if (!s) return NaN;

  // Standard or comma decimal
  const simple = parseFloat(s.replace(',', '.'));
  if (/^-?\d+([.,]\d+)?$/.test(s)) return simple;

  // DMS format e.g. 12°02'47.5"S or 12 02 47 S
  const dms = s.match(/^(-?\d+(?:[.,]\d+)?)\s*[°º]\s*(\d+(?:[.,]\d+)?)?\s*['′]?\s*(\d+(?:[.,]\d+)?)?\s*["″]?\s*([NSEWO])?$/i);
  if (dms) {
    const deg = parseFloat(dms[1].replace(',', '.')) || 0;
    const min = parseFloat((dms[2] || '0').replace(',', '.')) || 0;
    const sec = parseFloat((dms[3] || '0').replace(',', '.')) || 0;
    const hemi = (dms[4] || '').toUpperCase();
    let dec = Math.abs(deg) + min / 60 + sec / 3600;
    if (deg < 0 || hemi === 'S' || hemi === 'W' || hemi === 'O') dec = -dec;
    return dec;
  }

  return simple;
}

const LAT_ALIASES = ['latitud', 'lat', 'latitude', 'y', 'coord y', 'coordenada y'];
const LON_ALIASES = ['longitud', 'lon', 'lng', 'long', 'longitude', 'x', 'coord x', 'coordenada x'];
const MAT_ALIASES = ['matricula', 'placa', 'vehiculo', 'unidad', 'patente', 'dominio', 'plate'];
const SPD_ALIASES = ['velocidad', 'speed', 'vel', 'kmh', 'km/h', 'velocidad (km/h)'];
const TIME_ALIASES = ['fecha', 'hora', 'fecha y hora', 'fecha_hora', 'timestamp', 'date', 'time', 'datetime'];

function parseSpeedKmh(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function matchAlias(n: string, aliases: string[]): boolean {
  if (aliases.includes(n)) return true;
  return aliases.some((a) => n.startsWith(a + ' ') || n.endsWith(' ' + a));
}

export function readHeaderRow(ws: XLSX.WorkSheet, range: XLSX.Range, R: number): { header: string[]; idx: ColumnMapping } {
  const C0 = range.s.c;
  const C1 = range.e.c;
  const header: string[] = [];
  const idx: ColumnMapping = { lat: -1, lon: -1, mat: -1, speed: -1, time: -1 };

  for (let c = C0; c <= C1; c++) {
    const h = ws[XLSX.utils.encode_cell({ r: R, c })];
    const t = String(h ? (h.w != null ? h.w : h.v ?? '') : '').trim();
    header.push(t || `Col ${c - C0 + 1}`);
    const n = normHeader(t);
    if (idx.lat < 0 && matchAlias(n, LAT_ALIASES)) idx.lat = c - C0;
    if (idx.lon < 0 && matchAlias(n, LON_ALIASES)) idx.lon = c - C0;
    if (idx.mat < 0 && matchAlias(n, MAT_ALIASES)) idx.mat = c - C0;
    if (idx.speed < 0 && matchAlias(n, SPD_ALIASES)) idx.speed = c - C0;
    if (idx.time < 0 && matchAlias(n, TIME_ALIASES)) idx.time = c - C0;
  }

  return { header, idx };
}

export function parseWorkbook(
  data: Uint8Array,
  fileName: string,
  skipRows: number,
  customMapping?: Partial<ColumnMapping>
): DatasetState {
  const wb = XLSX.read(data, { type: 'array', cellNF: true, cellStyles: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) {
    throw new Error('La hoja de cálculo está vacía.');
  }
  const range = XLSX.utils.decode_range(ws['!ref']);
  const C0 = range.s.c;
  const C1 = range.e.c;
  const skip = Math.max(0, skipRows);

  let R0 = Math.min(range.s.r + skip, range.e.r);
  let hd = readHeaderRow(ws, range, R0);
  let auto = false;

  if (!customMapping && (hd.idx.lat < 0 || hd.idx.lon < 0)) {
    for (let R = range.s.r; R <= Math.min(range.e.r, range.s.r + 60); R++) {
      const candidate = readHeaderRow(ws, range, R);
      if (candidate.idx.lat >= 0 && candidate.idx.lon >= 0) {
        hd = candidate;
        R0 = R;
        auto = true;
        break;
      }
    }
  }

  const idx: ColumnMapping = {
    lat: customMapping?.lat !== undefined ? customMapping.lat : hd.idx.lat,
    lon: customMapping?.lon !== undefined ? customMapping.lon : hd.idx.lon,
    mat: customMapping?.mat !== undefined ? customMapping.mat : hd.idx.mat,
    speed: customMapping?.speed !== undefined ? customMapping.speed : hd.idx.speed,
    time: customMapping?.time !== undefined ? customMapping.time : hd.idx.time,
  };

  if (idx.lat < 0 || idx.lon < 0) {
    throw new Error('No se encontraron las columnas "Latitud" y "Longitud" en las primeras filas del archivo.');
  }

  const removedRows = R0 - range.s.r;
  const rows: PointRow[] = [];
  let idCounter = 1;

  for (let r = R0 + 1; r <= range.e.r; r++) {
    const d: (string | number)[] = [];
    const raw: unknown[] = [];
    let any = false;

    for (let cc = C0; cc <= C1; cc++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: cc })];
      if (cell) any = true;
      d.push(cell ? (cell.w != null ? cell.w : cell.v == null ? '' : cell.v) : '');
      raw.push(cell ? cell.v : null);
    }

    if (!any) continue;

    const la = parseCoord(raw[idx.lat] ?? d[idx.lat]);
    const lo = parseCoord(raw[idx.lon] ?? d[idx.lon]);
    const valid =
      Number.isFinite(la) &&
      Number.isFinite(lo) &&
      Math.abs(la) <= 90 &&
      Math.abs(lo) <= 180 &&
      !(la === 0 && lo === 0);

    const plate = idx.mat >= 0 ? String(d[idx.mat] ?? '').trim() : '';
    const speed = idx.speed >= 0 ? String(d[idx.speed] ?? '').trim() : '';
    const speedKmh = idx.speed >= 0 ? parseSpeedKmh(raw[idx.speed] ?? d[idx.speed]) : null;
    const timestamp = idx.time >= 0 ? String(d[idx.time] ?? '').trim() : '';

    rows.push({
      id: idCounter++,
      src: r,
      d,
      lat: la,
      lon: lo,
      valid,
      plate,
      speed,
      speedKmh,
      timestamp,
      x: 0,
      y: 0,
      mpp: 1,
      R: 0,
      dist: null,
      excess: null,
      half: 0,
      wayId: null,
      wayObj: null,
      road: '',
      inside: false,
      rescued: false,
      confidence: 'alta',
      manualOverride: null,
    });
  }

  return {
    ws,
    range,
    hdr: R0,
    sheetName,
    header: hd.header,
    idx,
    rows,
    ways: [],
    wayIds: {},
    done: {},
    analyzed: false,
    mode: 'esri',
    zA: 19,
    base: fileName.replace(/\.[^.]+$/, '') + '_en_carretera',
    removedRows,
    autoDetected: auto,
  };
}

export function exportFilteredXlsx(state: DatasetState, includeDiagnostics: boolean): number {
  const rowsToKeep = includeDiagnostics
    ? state.rows.filter((r) => r.valid)
    : state.rows.filter((r) => r.valid && isEffectiveInside(r));

  if (!rowsToKeep.length) return 0;

  if (!state.ws || !state.range) {
    // Sample dataset fallback: build sheet from arrays
    const header = includeDiagnostics
      ? [...state.header, 'Estado_Via', 'Distancia_m', 'Nombre_Via', 'Tipo_Via', 'Confianza', 'Revision_Manual']
      : state.header;
    const aoa: (string | number)[][] = [header];
    rowsToKeep.forEach((r) => {
      const base = [...r.d];
      if (includeDiagnostics) {
        base.push(
          isEffectiveInside(r) ? 'Dentro de carretera' : 'Fuera de carretera',
          r.dist != null ? Number((r.dist * r.mpp).toFixed(2)) : '',
          r.wayObj?.name || r.road || '',
          r.wayObj?.kind || '',
          getConfidenceLabel(r.confidence),
          r.manualOverride ? (r.manualOverride === 'in' ? 'Forzado dentro' : 'Forzado fuera') : 'Automático'
        );
      }
      aoa.push(base);
    });
    const outWs = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, outWs, state.sheetName.slice(0, 31));
    const suffix = includeDiagnostics ? '_diagnostico.xlsx' : '.xlsx';
    XLSX.writeFile(wb, state.base + suffix);
    return rowsToKeep.length;
  }

  const R0 = state.hdr;
  const C0 = state.range.s.c;
  const C1 = state.range.e.c;
  const ws = state.ws;
  const out: XLSX.WorkSheet = {};
  const srcRows = [R0, ...rowsToKeep.map((r) => r.src)];

  srcRows.forEach((sr, i) => {
    for (let c = C0; c <= C1; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: sr, c })];
      if (cell) out[XLSX.utils.encode_cell({ r: i, c })] = Object.assign({}, cell);
    }
    if (includeDiagnostics) {
      const diagCols =
        i === 0
          ? ['Estado_Via', 'Distancia_m', 'Nombre_Via', 'Tipo_Via', 'Limite_Via_kmh', 'Velocidad_kmh', 'Confianza', 'Revision_Manual']
          : (() => {
              const r = rowsToKeep[i - 1];
              return [
                isEffectiveInside(r) ? 'Dentro de carretera' : 'Fuera de carretera',
                r.dist != null ? Number((r.dist * r.mpp).toFixed(2)) : '',
                r.wayObj?.name || r.road || '',
                r.wayObj?.kind || '',
                r.wayObj?.maxspeed ?? '',
                r.speedKmh ?? '',
                getConfidenceLabel(r.confidence),
                r.manualOverride ? (r.manualOverride === 'in' ? 'Forzado dentro' : 'Forzado fuera') : 'Automático',
              ];
            })();

      diagCols.forEach((val, offset) => {
        const colIdx = C1 + 1 + offset;
        out[XLSX.utils.encode_cell({ r: i, c: colIdx })] = {
          t: typeof val === 'number' ? 'n' : 's',
          v: val,
        };
      });
    }
  });

  const endCol = includeDiagnostics ? C1 + 8 : C1;
  const ref = XLSX.utils.encode_range({ s: { r: 0, c: C0 }, e: { r: srcRows.length - 1, c: endCol } });
  out['!ref'] = ref;
  out['!autofilter'] = { ref };
  if (ws['!cols']) out['!cols'] = ws['!cols'];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, out, state.sheetName.slice(0, 31));
  const fileName = includeDiagnostics ? `${state.base}_diagnostico.xlsx` : `${state.base}.xlsx`;
  XLSX.writeFile(wb, fileName, { cellStyles: true });
  return rowsToKeep.length;
}

export function exportCsv(state: DatasetState, onlyInside: boolean): number {
  const rowsToKeep = state.rows.filter((r) => r.valid && (!onlyInside || isEffectiveInside(r)));
  if (!rowsToKeep.length) return 0;

  const escCsv = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const headers = [...state.header, 'Estado_Via', 'Distancia_m', 'Nombre_Via', 'Confianza'];
  const lines = [headers.map(escCsv).join(',')];

  rowsToKeep.forEach((r) => {
    const rowVals = [
      ...r.d,
      isEffectiveInside(r) ? 'Dentro' : 'Fuera',
      r.dist != null ? (r.dist * r.mpp).toFixed(2) : '',
      r.wayObj?.name || r.road || '',
      getConfidenceLabel(r.confidence),
    ];
    lines.push(rowVals.map(escCsv).join(','));
  });

  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.base}${onlyInside ? '' : '_completo'}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return rowsToKeep.length;
}
