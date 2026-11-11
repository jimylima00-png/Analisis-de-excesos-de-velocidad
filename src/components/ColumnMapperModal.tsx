import { useState } from 'react';
import { X } from 'lucide-react';
import type { ColumnMapping } from '../types/geo';

interface ColumnMapperModalProps {
  header: string[];
  mapping: ColumnMapping;
  onClose: () => void;
  onApply: (next: ColumnMapping) => void;
}

export function ColumnMapperModal({ header, mapping, onClose, onApply }: ColumnMapperModalProps) {
  const [lat, setLat] = useState(mapping.lat);
  const [lon, setLon] = useState(mapping.lon);
  const [mat, setMat] = useState(mapping.mat);
  const [speed, setSpeed] = useState(mapping.speed);
  const [time, setTime] = useState(mapping.time);

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-950/45 p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-md w-full p-5 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Asignación de columnas
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-600 dark:text-slate-400 mb-4">
          Selecciona qué columnas del archivo corresponden a las coordenadas y metadatos del vehículo.
        </p>

        <div className="space-y-3">
          {[
            { label: 'Latitud (obligatorio)', val: lat, set: setLat, required: true },
            { label: 'Longitud (obligatorio)', val: lon, set: setLon, required: true },
            { label: 'Matrícula / Placa', val: mat, set: setMat, required: false },
            { label: 'Velocidad', val: speed, set: setSpeed, required: false },
            { label: 'Fecha y Hora', val: time, set: setTime, required: false },
          ].map((field) => (
            <label key={field.label} className="block">
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {field.label}
              </span>
              <select
                value={field.val}
                onChange={(e) => field.set(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
              >
                {!field.required && <option value={-1}>— No usar —</option>}
                {header.map((h, i) => (
                  <option key={i} value={i}>
                    {h} (Columna {i + 1})
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={lat < 0 || lon < 0}
            onClick={() => onApply({ lat, lon, mat, speed, time })}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Aplicar y recargar
          </button>
        </div>
      </div>
    </div>
  );
}
