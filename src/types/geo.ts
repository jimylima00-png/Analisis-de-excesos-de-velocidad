import type * as XLSX from 'xlsx';

export type AnalysisMode = 'esri' | 'osm' | 'hybrid';
export type RoadGroup = 'main' | 'sec' | 'local' | 'svc';
export type ConfidenceLevel = 'alta' | 'media' | 'dudosa';
export type ManualOverride = 'in' | 'out' | null;
export type FilterStatus = 'all' | 'in' | 'out' | 'doubtful' | 'overridden';

export interface OsmWay {
  id: number;
  pts: [number, number][];
  pp: [number, number][];
  lat: number;
  bb: [number, number, number, number];
  name: string;
  kind: string;
  grp: RoadGroup;
  half: number;
  maxspeed: number | null;
}

export interface PointRow {
  id: number;
  src: number;
  d: (string | number)[];
  lat: number;
  lon: number;
  valid: boolean;
  plate: string;
  speed: string;
  speedKmh: number | null;
  timestamp: string;
  x: number;
  y: number;
  mpp: number;
  R: number;
  dist: number | null;
  excess: number | null;
  half: number;
  wayId: number | null;
  wayObj: OsmWay | null;
  road: string;
  inside: boolean;
  rescued: boolean;
  confidence: ConfidenceLevel;
  manualOverride: ManualOverride;
  rasterDist?: number | null;
  rasterExcessPx?: number | null;
  rasterInside?: boolean;
  osmDist?: number | null;
  osmExcessMeters?: number | null;
  osmInside?: boolean;
}

export interface ColumnMapping {
  lat: number;
  lon: number;
  mat: number;
  speed: number;
  time: number;
}

export interface DatasetState {
  ws: XLSX.WorkSheet | null;
  range: XLSX.Range | null;
  hdr: number;
  sheetName: string;
  header: string[];
  idx: ColumnMapping;
  rows: PointRow[];
  ways: OsmWay[];
  wayIds: Record<number, number>;
  done: Record<number, boolean>;
  analyzed: boolean;
  mode: AnalysisMode;
  zA: number;
  base: string;
  removedRows: number;
  autoDetected: boolean;
  isSample?: boolean;
}

export interface TileMaskResult {
  bits?: Uint8Array;
  placeholder?: boolean;
  err?: 'cors' | 'load';
}
