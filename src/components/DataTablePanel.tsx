import { Search, MapPin, RotateCcw } from 'lucide-react';
import type { FilterStatus, ManualOverride, PointRow } from '../types/geo';
import { getConfidenceLabel, isEffectiveInside } from '../utils/geoMath';

interface DataTablePanelProps {
  rows: PointRow[];
  analyzed: boolean;
  filterStatus: FilterStatus;
  searchQuery: string;
  selectedPointId: number | null;
  selectedPlate: string;
  minSpeedKmh: number;
  onFilterChange: (f: FilterStatus) => void;
  onSearchChange: (q: string) => void;
  onSelectPoint: (id: number) => void;
  onOverridePoint: (id: number, override: ManualOverride) => void;
}

export function DataTablePanel({
  rows,
  analyzed,
  filterStatus,
  searchQuery,
  selectedPointId,
  selectedPlate,
  minSpeedKmh,
  onFilterChange,
  onSearchChange,
  onSelectPoint,
  onOverridePoint,
}: DataTablePanelProps) {
  const q = searchQuery.trim().toLowerCase();

  const filtered = rows.filter((r) => {
    if (!r.valid) return false;
    if (selectedPlate && r.plate !== selectedPlate) return false;
    if (minSpeedKmh > 0 && r.speedKmh != null && r.speedKmh < minSpeedKmh) return false;

    const effIn = isEffectiveInside(r);
    if (analyzed) {
      if (filterStatus === 'in' && !effIn) return false;
      if (filterStatus === 'out' && effIn) return false;
      if (filterStatus === 'doubtful' && r.confidence !== 'dudosa') return false;
      if (filterStatus === 'overridden' && r.manualOverride === null) return false;
    }
    if (q) {
      const hay = `${r.plate} ${r.road} ${r.id} ${r.lat.toFixed(5)} ${r.lon.toFixed(5)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tabs: Array<{ id: FilterStatus; label: string }> = [
    { id: 'all', label: 'Todos' },
    { id: 'in', label: 'Dentro' },
    { id: 'out', label: 'Fuera' },
    { id: 'doubtful', label: 'Dudosos' },
    { id: 'overridden', label: 'Revisados' },
  ];

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={!analyzed && t.id !== 'all'}
              onClick={() => onFilterChange(t.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                filterStatus === t.id
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 min-w-[220px] max-w-xs">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Buscar matrícula, vía o fila…"
            className="w-full pl-9 pr-3 py-1.5 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        </div>
      </div>

      <div className="overflow-x-auto max-h-[380px] overflow-y-auto">
        <table className="w-full text-left border-collapse text-sm">
          <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/95 border-b border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 z-10">
            <tr>
              <th className="py-2.5 px-3 w-12 text-right">#</th>
              <th className="py-2.5 px-3">Matrícula</th>
              <th className="py-2.5 px-3">Coordenadas</th>
              <th className="py-2.5 px-3">Velocidad</th>
              <th className="py-2.5 px-3">Estado</th>
              <th className="py-2.5 px-3 text-right">Distancia</th>
              <th className="py-2.5 px-3">Vía detectada</th>
              <th className="py-2.5 px-3">Confianza</th>
              <th className="py-2.5 px-3 text-right">Revisión manual</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                  No hay puntos que coincidan con el filtro actual.
                </td>
              </tr>
            ) : (
              filtered.slice(0, 500).map((r) => {
                const effIn = isEffectiveInside(r);
                const isSelected = selectedPointId === r.id;
                const distMeters = r.dist != null ? (r.dist * r.mpp).toFixed(1) : null;

                return (
                  <tr
                    key={r.id}
                    onClick={() => onSelectPoint(r.id)}
                    className={`cursor-pointer transition-colors h-10 ${
                      isSelected
                        ? 'bg-blue-50/70 dark:bg-blue-950/40'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-xs text-slate-500">
                      {r.id}
                    </td>
                    <td className="py-2 px-3 font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        {r.plate || '—'}
                      </span>
                    </td>
                    <td className="py-2 px-3 font-mono tabular-nums text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {r.lat.toFixed(5)}, {r.lon.toFixed(5)}
                    </td>
                    <td className="py-2 px-3 font-mono tabular-nums text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                      <span>{r.speed || '—'}</span>
                      {r.wayObj?.maxspeed != null && r.speedKmh != null && r.speedKmh > r.wayObj.maxspeed && (
                        <span className="ml-1.5 text-amber-700 dark:text-amber-400 font-semibold">
                          (Lím. {r.wayObj.maxspeed})
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      {!analyzed ? (
                        <span className="text-xs text-slate-500">Pendiente</span>
                      ) : effIn ? (
                        <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                          Dentro
                        </span>
                      ) : (
                        <span className="text-xs font-semibold text-red-700 dark:text-red-400">
                          Fuera
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                      {distMeters != null ? `${distMeters} m` : '—'}
                    </td>
                    <td className="py-2 px-3 text-xs text-slate-600 dark:text-slate-400 max-w-[180px] truncate">
                      {r.road || (analyzed ? '—' : 'Sin analizar')}
                    </td>
                    <td className="py-2 px-3 text-xs whitespace-nowrap">
                      {!analyzed ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <span
                          className={
                            r.confidence === 'dudosa'
                              ? 'text-amber-700 dark:text-amber-400 font-medium'
                              : 'text-slate-600 dark:text-slate-400'
                          }
                        >
                          {getConfidenceLabel(r.confidence)}
                          {r.rescued ? ' · vecino' : ''}
                        </span>
                      )}
                    </td>
                    <td
                      className="py-2 px-3 text-right whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          disabled={!analyzed}
                          onClick={() => onOverridePoint(r.id, r.manualOverride === 'in' ? null : 'in')}
                          className={`px-2 py-1 text-xs rounded border transition-colors disabled:opacity-40 ${
                            r.manualOverride === 'in'
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          Dentro
                        </button>
                        <button
                          type="button"
                          disabled={!analyzed}
                          onClick={() => onOverridePoint(r.id, r.manualOverride === 'out' ? null : 'out')}
                          className={`px-2 py-1 text-xs rounded border transition-colors disabled:opacity-40 ${
                            r.manualOverride === 'out'
                              ? 'bg-red-600 text-white border-red-600'
                              : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          Fuera
                        </button>
                        {r.manualOverride !== null && (
                          <button
                            type="button"
                            title="Restaurar cálculo automático"
                            onClick={() => onOverridePoint(r.id, null)}
                            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > 500 && (
        <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500">
          Mostrando los primeros 500 de {filtered.length.toLocaleString('es-PE')} puntos filtrados. Usa el buscador para filtrar registros específicos.
        </div>
      )}
    </div>
  );
}
