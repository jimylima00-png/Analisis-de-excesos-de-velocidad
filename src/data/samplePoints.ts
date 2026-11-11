import type { DatasetState, PointRow } from '../types/geo';

const SAMPLE_DATA: Array<[string, string, number, number, string, string]> = [
  ['ABC-123', '2026-10-14 08:12:05', -12.09284, -77.02218, '104 km/h', 'Vía Expresa Paseo de la República'],
  ['ABC-123', '2026-10-14 08:12:35', -12.09562, -77.02249, '108 km/h', 'Vía Expresa Paseo de la República'],
  ['ABC-123', '2026-10-14 08:13:10', -12.09891, -77.02282, '96 km/h', 'Vía Expresa Paseo de la República'],
  ['DEF-456', '2026-10-14 09:05:18', -12.08941, -77.00523, '88 km/h', 'Av. Javier Prado Este'],
  ['DEF-456', '2026-10-14 09:05:48', -12.08889, -77.00181, '92 km/h', 'Av. Javier Prado Este'],
  ['DEF-456', '2026-10-14 09:06:15', -12.08815, -76.99812, '85 km/h', 'Av. Javier Prado Este'],
  ['GHI-789', '2026-10-14 10:21:00', -12.11124, -76.97942, '115 km/h', 'Panamericana Sur'],
  ['GHI-789', '2026-10-14 10:21:30', -12.11495, -76.97938, '118 km/h', 'Panamericana Sur'],
  ['GHI-789', '2026-10-14 10:22:02', -12.11861, -76.97931, '112 km/h', 'Panamericana Sur'],
  ['JKL-321', '2026-10-14 11:40:12', -12.09382, -77.02415, '65 km/h', 'Estacionamiento / Fuera de vía'],
  ['JKL-321', '2026-10-14 11:41:05', -12.09612, -77.02011, '72 km/h', 'Interior de manzana'],
  ['MNO-654', '2026-10-14 12:15:40', -12.10455, -76.98120, '94 km/h', 'Trébol de Javier Prado'],
  ['MNO-654', '2026-10-14 12:16:10', -12.10620, -76.97995, '99 km/h', 'Panamericana Sur'],
  ['PQR-987', '2026-10-14 13:02:19', -12.12340, -76.97910, '105 km/h', 'Panamericana Sur'],
  ['PQR-987', '2026-10-14 13:02:50', -12.12680, -76.97885, '102 km/h', 'Panamericana Sur'],
  ['STU-112', '2026-10-14 14:18:00', -12.08720, -77.00790, '78 km/h', 'Parque / Fuera de vía'],
];

export function createSampleDataset(): DatasetState {
  const header = ['Matrícula', 'Fecha y Hora', 'Latitud', 'Longitud', 'Velocidad', 'Referencia'];
  const rows: PointRow[] = SAMPLE_DATA.map((item, idx) => {
    const spdNum = parseFloat(item[4]);
    return {
      id: idx + 1,
      src: idx + 1,
      d: item,
      lat: item[2],
      lon: item[3],
      valid: true,
      plate: item[0],
      speed: item[4],
      speedKmh: Number.isFinite(spdNum) ? spdNum : null,
      timestamp: item[1],
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
    };
  });

  return {
    ws: null,
    range: null,
    hdr: 0,
    sheetName: 'Muestra_Exceso_Velocidad',
    header,
    idx: { lat: 2, lon: 3, mat: 0, speed: 4, time: 1 },
    rows,
    ways: [],
    wayIds: {},
    done: {},
    analyzed: false,
    mode: 'esri',
    zA: 19,
    base: 'muestra_velocidad_en_carretera',
    removedRows: 0,
    autoDetected: false,
    isSample: true,
  };
}
