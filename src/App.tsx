import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Upload,
  Download,
  RefreshCw,
  Columns,
  Sun,
  Moon,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  Info,
  RotateCcw,
} from 'lucide-react';
import type {
  AnalysisMode,
  ColumnMapping,
  DatasetState,
  FilterStatus,
  ManualOverride,
  RoadGroup,
} from './types/geo';
import { classifyPoints, isEffectiveInside, mpp, ZMAX } from './utils/geoMath';
import { exportCsv, exportFilteredXlsx, parseWorkbook } from './utils/excel';
import { clearRasterCache, runRasterAnalysis } from './utils/rasterAnalysis';
import { computeOsmDistances, runOsmAnalysis } from './utils/overpassAnalysis';
import { createSampleDataset } from './data/samplePoints';
import { MapPanel } from './components/MapPanel';
import { DataTablePanel } from './components/DataTablePanel';
import { ColumnMapperModal } from './components/ColumnMapperModal';

interface StatusNotice {
  type: 'info' | 'ok' | 'err';
  text: string;
}

export default function App() {
  const [dark, setDark] = useState(false);
  const [skipRows, setSkipRows] = useState(3);
  const [rawFile, setRawFile] = useState<{ data: Uint8Array; name: string } | null>(null);
  const [dataset, setDataset] = useState<DatasetState | null>(null);
  const [notice, setNotice] = useState<StatusNotice | null>(null);

  const [mode, setMode] = useState<AnalysisMode>('esri');
  const [tolMeters, setTolMeters] = useState(0);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showRoads, setShowRoads] = useState(true);
  const [showMask, setShowMask] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [clusterPoints, setClusterPoints] = useState(true);
  const [enabledGroups, setEnabledGroups] = useState<Record<RoadGroup, boolean>>({
    main: true,
    sec: false,
    local: false,
    svc: false,
  });

  const [analyzing, setAnalyzing] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [selectedPointId, setSelectedPointId] = useState<number | null>(null);
  const [selectedPlate, setSelectedPlate] = useState<string>('');
  const [minSpeedKmh, setMinSpeedKmh] = useState<number>(0);
  const [showTrajectory, setShowTrajectory] = useState<boolean>(false);
  const [fitTrigger, setFitTrigger] = useState(0);
  const [showMapper, setShowMapper] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const runAnalysis = useCallback(
    async (targetState: DatasetState, targetMode: AnalysisMode, groups: Record<RoadGroup, boolean>, tol: number) => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
      const ctl = new AbortController();
      abortRef.current = ctl;

      setAnalyzing(true);
      setProgressPct(2);
      setProgressMsg('Preparando análisis…');

      const next: DatasetState = {
        ...targetState,
        rows: targetState.rows.map((r) => ({ ...r })),
        analyzed: false,
        mode: targetMode,
      };
      setDataset(next);

      try {
        if (targetMode === 'esri') {
          const { usedZoom } = await runRasterAnalysis(
            next.rows,
            (pct, msg) => {
              setProgressPct(pct);
              setProgressMsg(msg);
            },
            ctl.signal
          );
          next.zA = usedZoom;
          classifyPoints(next.rows, tol, 'esri');
        } else if (targetMode === 'osm') {
          await runOsmAnalysis(
            next,
            groups,
            (pct, msg) => {
              setProgressPct(pct);
              setProgressMsg(msg);
            },
            ctl.signal
          );
          next.zA = ZMAX;
          classifyPoints(next.rows, tol, 'osm');
        } else {
          // Hybrid: run Raster + OSM and compare
          const { usedZoom } = await runRasterAnalysis(
            next.rows,
            (pct, msg) => {
              setProgressPct(Math.round(pct * 0.45));
              setProgressMsg(`[1/2 Mapa] ${msg}`);
            },
            ctl.signal
          );
          next.zA = usedZoom;
          classifyPoints(next.rows, tol, 'esri');
          next.rows.forEach((r) => {
            r.rasterInside = r.inside;
          });

          await runOsmAnalysis(
            next,
            groups,
            (pct, msg) => {
              setProgressPct(45 + Math.round(pct * 0.55));
              setProgressMsg(`[2/2 Vectorial] ${msg}`);
            },
            ctl.signal
          );
          classifyPoints(next.rows, tol, 'osm');
          next.rows.forEach((r) => {
            r.osmInside = r.inside;
          });

          classifyPoints(next.rows, tol, 'hybrid');
        }

        next.analyzed = true;
        setDataset({ ...next });

        const validCount = next.rows.filter((r) => r.valid).length;
        const inCount = next.rows.filter((r) => r.valid && isEffectiveInside(r)).length;
        const doubtfulCount = next.rows.filter((r) => r.valid && r.confidence === 'dudosa').length;

        setNotice({
          type: 'ok',
          text: `Análisis completado (${targetMode === 'esri' ? `Dibujo OSM z${next.zA}` : targetMode === 'osm' ? 'Vectorial OSM' : 'Doble verificación'}): ${inCount} de ${validCount} puntos dentro de carretera${doubtfulCount > 0 ? ` · ${doubtfulCount} dudosos para revisión` : ''}.`,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setNotice({ type: 'info', text: 'Análisis cancelado por el usuario.' });
        } else if (err instanceof Error && err.message === 'NO_TILES') {
          setMode('osm');
          setNotice({
            type: 'err',
            text: 'No se pudo leer el dibujo del mapa OpenStreetMap. Cambiando automáticamente a datos vectoriales OSM.',
          });
          setTimeout(() => runAnalysis(next, 'osm', groups, tol), 100);
        } else {
          const msg = err instanceof Error ? err.message : 'Error desconocido';
          setNotice({
            type: 'err',
            text: `No se pudo completar el análisis (${msg}). Puedes reintentar con «Reanalizar» o cambiar de referencia.`,
          });
        }
      } finally {
        setAnalyzing(false);
        setProgressPct(0);
      }
    },
    []
  );

  const handleReset = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    clearRasterCache();
    setAnalyzing(false);
    setProgressPct(0);
    setProgressMsg('');
    setDataset(null);
    setRawFile(null);
    setNotice(null);
    setSelectedPointId(null);
    setSelectedPlate('');
    setMinSpeedKmh(0);
    setSearchQuery('');
    setFilterStatus('all');
    setShowTrajectory(false);
    setShowMapper(false);
  }, []);

  const loadRawWorkbook = useCallback(
    (data: Uint8Array, name: string, skip: number, customMapping?: Partial<ColumnMapping>) => {
      try {
        if (abortRef.current) {
          abortRef.current.abort();
        }
        clearRasterCache();
        const parsed = parseWorkbook(data, name, skip, customMapping);
        setDataset(parsed);
        setSelectedPointId(null);
        setSelectedPlate('');
        setMinSpeedKmh(0);
        setSearchQuery('');
        setFilterStatus('all');
        setFitTrigger((c) => c + 1);

        const validCount = parsed.rows.filter((r) => r.valid).length;
        setNotice({
          type: 'info',
          text: `Archivo cargado: se omitieron ${parsed.removedRows} filas${parsed.autoDetected ? ' (detectadas automáticamente)' : ''}; ${parsed.rows.length} filas de datos, ${validCount} con coordenadas válidas.`,
        });
        runAnalysis(parsed, mode, enabledGroups, tolMeters);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error al leer el archivo';
        setNotice({ type: 'err', text: msg });
      }
    },
    [enabledGroups, mode, runAnalysis, tolMeters]
  );

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf = e.target?.result;
      if (!(buf instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(buf);
      setRawFile({ data: bytes, name: file.name });
      loadRawWorkbook(bytes, file.name, skipRows);
    };
    setNotice({ type: 'info', text: 'Leyendo archivo Excel…' });
    reader.readAsArrayBuffer(file);
  };

  const handleLoadSample = () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    clearRasterCache();
    setRawFile(null);
    const sample = createSampleDataset();
    setDataset(sample);
    setSelectedPointId(null);
    setSelectedPlate('');
    setMinSpeedKmh(0);
    setSearchQuery('');
    setFilterStatus('all');
    setFitTrigger((c) => c + 1);
    setNotice({
      type: 'info',
      text: 'Muestra de 16 puntos GPS cargada (Lima: Vía Expresa, Av. Javier Prado y Panamericana Sur).',
    });
    runAnalysis(sample, mode, enabledGroups, tolMeters);
  };

  const handleTolChange = (nextTol: number) => {
    setTolMeters(nextTol);
    if (!dataset || !dataset.analyzed) return;
    const nextRows = dataset.rows.map((r) => {
      const copy = { ...r };
      if (dataset.mode === 'hybrid') {
        if (copy.rasterExcessPx != null) {
          copy.rasterInside = copy.rasterExcessPx <= nextTol / copy.mpp + 0.5;
        }
        if (copy.osmExcessMeters != null) {
          copy.osmInside = copy.osmExcessMeters <= nextTol;
        }
      }
      return copy;
    });
    classifyPoints(nextRows, nextTol, dataset.mode);
    setDataset({ ...dataset, rows: nextRows });
  };

  const handleGroupToggle = (grp: RoadGroup) => {
    const nextGroups = { ...enabledGroups, [grp]: !enabledGroups[grp] };
    setEnabledGroups(nextGroups);
    if (!dataset || !dataset.analyzed || dataset.mode === 'esri') return;

    const nextRows = dataset.rows.map((r) => ({ ...r }));
    computeOsmDistances(nextRows, dataset.ways, nextGroups);
    classifyPoints(nextRows, tolMeters, dataset.mode);
    setDataset({ ...dataset, rows: nextRows });
  };

  const handleOverridePoint = (id: number, override: ManualOverride) => {
    if (!dataset) return;
    const nextRows = dataset.rows.map((r) => (r.id === id ? { ...r, manualOverride: override } : r));
    setDataset({ ...dataset, rows: nextRows });
  };

  const handleExport = (type: 'inside_xlsx' | 'diag_xlsx' | 'csv') => {
    if (!dataset || !dataset.analyzed) return;
    let count = 0;
    if (type === 'inside_xlsx') {
      count = exportFilteredXlsx(dataset, false);
    } else if (type === 'diag_xlsx') {
      count = exportFilteredXlsx(dataset, true);
    } else {
      count = exportCsv(dataset, true);
    }

    if (count === 0) {
      setNotice({ type: 'err', text: 'No hay puntos dentro de carretera para exportar.' });
    } else {
      setNotice({
        type: 'ok',
        text: `Archivo exportado con ${count} registros.`,
      });
    }
  };

  // Compute summary metrics
  const totalRows = dataset?.rows.length ?? 0;
  const validRows = dataset?.rows.filter((r) => r.valid) ?? [];
  const invalidCount = totalRows - validRows.length;
  const inCount = dataset?.analyzed ? validRows.filter((r) => isEffectiveInside(r)).length : 0;
  const outCount = dataset?.analyzed ? validRows.length - inCount : 0;
  const doubtfulCount = dataset?.analyzed ? validRows.filter((r) => r.confidence === 'dudosa').length : 0;
  const pctIn = dataset?.analyzed && validRows.length ? ((inCount / validRows.length) * 100).toFixed(1) : '0.0';

  const refLat = validRows.length ? validRows[Math.floor(validRows.length / 2)].lat : -12;
  const activeZoom = dataset?.zA ?? ZMAX;
  const tolPx = Math.round(tolMeters / mpp(refLat, activeZoom));

  const plateCounts: Record<string, number> = {};
  validRows.forEach((r) => {
    if (r.plate) plateCounts[r.plate] = (plateCounts[r.plate] || 0) + 1;
  });
  const uniquePlates = Object.keys(plateCounts).sort();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors">
      {/* Top Bar Contract: Brand wordmark — Nav/Summary — Primary Action */}
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-[1380px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <span className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
            Puntos en Carretera
          </span>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400">
            <a href="#mapa" className="hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap shrink-0">
              Mapa
            </a>
            <a href="#tabla" className="hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap shrink-0">
              Tabla de puntos
            </a>
            <button
              type="button"
              onClick={handleLoadSample}
              className="hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap shrink-0"
            >
              Cargar muestra
            </button>
            {typeof window !== 'undefined' && window.location.protocol !== 'file:' && (
              <a
                href="/puntos_en_carretera.html"
                download="puntos_en_carretera.html"
                className="hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap shrink-0"
              >
                Descargar HTML
              </a>
            )}
            <button
              type="button"
              onClick={() => setDark((d) => !d)}
              className="inline-flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap shrink-0"
              aria-label="Cambiar tema"
            >
              {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              <span>{dark ? 'Claro' : 'Oscuro'}</span>
            </button>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xls,.xlsx,.xlsm,.csv"
              className="hidden"
              onChange={(e) => {
                handleFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            {dataset && (
              <button
                type="button"
                onClick={handleReset}
                title="Reiniciar búsqueda y cargar otro Excel"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reiniciar
              </button>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              <Upload className="w-3.5 h-3.5" />
              {dataset ? 'Cargar otro Excel' : 'Subir Excel'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1380px] mx-auto px-6 py-6 space-y-5">
        {/* Upload / Config Strip */}
        {!dataset ? (
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8">
            <div className="max-w-2xl mx-auto text-center">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 mb-2">
                Detección de puntos GPS dentro de carretera
              </h1>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
                Sube un reporte Excel de exceso de velocidad con columnas de Latitud y Longitud. El sistema valida cada coordenada contra la red vial de OpenStreetMap y permite auditar casos dudosos antes de exportar.
              </p>

              <div
                onDragEnter={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  handleFile(e.dataTransfer.files?.[0]);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-10 cursor-pointer transition-colors ${
                  dragOver
                    ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20'
                    : 'border-slate-300 dark:border-slate-700 hover:border-blue-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                }`}
              >
                <FileSpreadsheet className="w-9 h-9 text-blue-600 dark:text-blue-400 mx-auto mb-3" />
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
                  Arrastra tu archivo .xls / .xlsx / .csv aquí o haz clic para seleccionarlo
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Detección automática de encabezados, coordenadas decimales o DMS y matrículas
                </p>
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-center gap-4 text-xs text-slate-600 dark:text-slate-400">
                <label className="inline-flex items-center gap-2">
                  <span>Omitir primeras</span>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={skipRows}
                    onChange={(e) => setSkipRows(Math.max(0, Number(e.target.value) || 0))}
                    className="w-14 px-2 py-1 text-center font-mono bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100"
                  />
                  <span>filas de encabezado</span>
                </label>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={handleLoadSample}
                  className="font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Probar con datos de muestra (16 puntos)
                </button>
              </div>
            </div>
          </section>
        ) : (
          <>
            {/* Status Notice */}
            {notice && (
              <div
                className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border text-sm ${
                  notice.type === 'ok'
                    ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300'
                    : notice.type === 'err'
                    ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-800 dark:text-red-300'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                {notice.type === 'ok' ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : notice.type === 'err' ? (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                ) : (
                  <Info className="w-4 h-4 shrink-0" />
                )}
                <span>{notice.text}</span>
              </div>
            )}

            {/* KPI Summary Strip */}
            <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {[
                { label: 'Filas totales', value: totalRows.toLocaleString('es-PE'), tone: 'neutral' },
                { label: 'Coordenadas válidas', value: validRows.length.toLocaleString('es-PE'), tone: 'neutral' },
                { label: 'Sin coordenadas', value: invalidCount.toLocaleString('es-PE'), tone: 'neutral' },
                { label: 'Dentro de carretera', value: dataset.analyzed ? inCount.toLocaleString('es-PE') : '…', tone: 'ok' },
                { label: 'Fuera de carretera', value: dataset.analyzed ? outCount.toLocaleString('es-PE') : '…', tone: 'bad' },
                {
                  label: doubtfulCount > 0 ? `Porcentaje (${doubtfulCount} dudosos)` : 'Porcentaje dentro',
                  value: dataset.analyzed ? `${pctIn} %` : '…',
                  tone: 'neutral',
                },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3"
                >
                  <div
                    className={`text-2xl font-bold font-mono tabular-nums leading-tight ${
                      stat.tone === 'ok'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : stat.tone === 'bad'
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-slate-900 dark:text-slate-100'
                    }`}
                  >
                    {stat.value}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{stat.label}</div>
                </div>
              ))}
            </section>

            {/* Controls Bar */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                  <span>Referencia:</span>
                  <select
                    value={mode}
                    disabled={analyzing}
                    onChange={(e) => {
                      const nextMode = e.target.value as AnalysisMode;
                      setMode(nextMode);
                      if (dataset) runAnalysis(dataset, nextMode, enabledGroups, tolMeters);
                    }}
                    className="px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  >
                    <option value="esri">Dibujo del mapa OpenStreetMap (z19)</option>
                    <option value="osm">Datos vectoriales OpenStreetMap (Overpass)</option>
                    <option value="hybrid">Doble verificación (Mapa + Vectorial)</option>
                  </select>
                </label>

                <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                  <span>Margen GPS:</span>
                  <input
                    type="range"
                    min={0}
                    max={25}
                    step={0.5}
                    value={tolMeters}
                    onChange={(e) => handleTolChange(parseFloat(e.target.value))}
                    className="w-32 accent-blue-600"
                  />
                  <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 w-24">
                    {tolMeters} m (≈{tolPx} px)
                  </span>
                </label>

                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-700 dark:text-slate-300">
                  {(mode === 'osm' || mode === 'hybrid') && (
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showRoads}
                        onChange={(e) => setShowRoads(e.target.checked)}
                        className="accent-blue-600"
                      />
                      Ver carreteras
                    </label>
                  )}
                  {(mode === 'esri' || mode === 'hybrid') && (
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showMask}
                        onChange={(e) => setShowMask(e.target.checked)}
                        className="accent-blue-600"
                      />
                      Ver franja detectada
                    </label>
                  )}
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showLabels}
                      onChange={(e) => setShowLabels(e.target.checked)}
                      className="accent-blue-600"
                    />
                    Matrículas
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={clusterPoints}
                      onChange={(e) => setClusterPoints(e.target.checked)}
                      className="accent-blue-600"
                    />
                    Agrupar
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showTrajectory}
                      onChange={(e) => setShowTrajectory(e.target.checked)}
                      className="accent-blue-600"
                    />
                    Trayectoria
                  </label>
                </div>

                {uniquePlates.length > 0 && (
                  <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                    <span>Matrícula:</span>
                    <select
                      value={selectedPlate}
                      onChange={(e) => {
                        setSelectedPlate(e.target.value);
                        setFitTrigger((c) => c + 1);
                      }}
                      className="px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                    >
                      <option value="">Todas ({uniquePlates.length})</option>
                      {uniquePlates.map((p) => (
                        <option key={p} value={p}>
                          {p} ({plateCounts[p]})
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                  <span>Vel. mín.:</span>
                  <input
                    type="number"
                    min={0}
                    max={250}
                    step={5}
                    value={minSpeedKmh}
                    onChange={(e) => setMinSpeedKmh(Math.max(0, Number(e.target.value) || 0))}
                    className="w-16 px-2 py-1 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                  <span className="text-slate-500">km/h</span>
                </label>

                <div className="flex-1" />

                <div className="flex flex-wrap items-center gap-2">
                  {rawFile && (
                    <button
                      type="button"
                      onClick={() => setShowMapper(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      <Columns className="w-3.5 h-3.5" />
                      Columnas
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={analyzing}
                    onClick={() => dataset && runAnalysis(dataset, mode, enabledGroups, tolMeters)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Reanalizar
                  </button>
                  <button
                    type="button"
                    disabled={!dataset.analyzed || inCount === 0}
                    onClick={() => handleExport('inside_xlsx')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-45 whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Solo dentro ({inCount})
                  </button>
                  <button
                    type="button"
                    disabled={!dataset.analyzed}
                    onClick={() => handleExport('diag_xlsx')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45 whitespace-nowrap shrink-0"
                  >
                    Diagnóstico (.xlsx)
                  </button>
                  <button
                    type="button"
                    disabled={!dataset.analyzed || inCount === 0}
                    onClick={() => handleExport('csv')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45 whitespace-nowrap shrink-0"
                  >
                    CSV
                  </button>
                </div>
              </div>

              {(mode === 'osm' || mode === 'hybrid') && (
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-400">
                  <span className="font-semibold text-slate-700 dark:text-slate-300">Tipos de vía:</span>
                  {[
                    { key: 'main' as RoadGroup, label: 'Autopistas, troncales y primarias', color: '#f59e0b' },
                    { key: 'sec' as RoadGroup, label: 'Secundarias y terciarias', color: '#ca8a04' },
                    { key: 'local' as RoadGroup, label: 'Locales y calles', color: '#0ea5e9' },
                    { key: 'svc' as RoadGroup, label: 'Servicio y trochas', color: '#6b7280' },
                  ].map((g) => (
                    <label key={g.key} className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={enabledGroups[g.key]}
                        onChange={() => handleGroupToggle(g.key)}
                        className="accent-blue-600"
                      />
                      <span className="w-3.5 h-1 rounded-full inline-block" style={{ background: g.color }} />
                      <span>{g.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </section>

            {/* Map Focal Anchor */}
            <section id="mapa" className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                <div className="flex items-center gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 inline-block" />
                    Dentro de carretera
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-600 inline-block" />
                    Fuera de carretera
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-600 inline-block" />
                    Pendiente
                  </span>
                </div>
                <span className="font-mono tabular-nums">
                  Zoom análisis: z{activeZoom} · 1 px ≈ {mpp(refLat, activeZoom).toFixed(2)} m
                </span>
              </div>

              <MapPanel
                state={dataset}
                filterStatus={filterStatus}
                searchQuery={searchQuery}
                showRoads={showRoads}
                showMask={showMask}
                showLabels={showLabels}
                clusterPoints={clusterPoints}
                enabledGroups={enabledGroups}
                selectedPointId={selectedPointId}
                selectedPlate={selectedPlate}
                minSpeedKmh={minSpeedKmh}
                showTrajectory={showTrajectory}
                analyzing={analyzing}
                progressMsg={progressMsg}
                progressPct={progressPct}
                fitTrigger={fitTrigger}
                onSelectPoint={setSelectedPointId}
                onCancelAnalysis={() => abortRef.current?.abort()}
              />
            </section>

            {/* Synchronized Data Table */}
            <section id="tabla" className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Auditoría y revisión manual de puntos
                </h2>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Haz clic en una fila para ubicarla en el mapa
                </span>
              </div>
              <DataTablePanel
                rows={dataset.rows}
                analyzed={dataset.analyzed}
                filterStatus={filterStatus}
                searchQuery={searchQuery}
                selectedPointId={selectedPointId}
                selectedPlate={selectedPlate}
                minSpeedKmh={minSpeedKmh}
                onFilterChange={setFilterStatus}
                onSearchChange={setSearchQuery}
                onSelectPoint={setSelectedPointId}
                onOverridePoint={handleOverridePoint}
              />
            </section>
          </>
        )}
      </main>

      {showMapper && dataset && rawFile && (
        <ColumnMapperModal
          header={dataset.header}
          mapping={dataset.idx}
          onClose={() => setShowMapper(false)}
          onApply={(nextMapping) => {
            setShowMapper(false);
            loadRawWorkbook(rawFile.data, rawFile.name, skipRows, nextMapping);
          }}
        />
      )}
    </div>
  );
}
