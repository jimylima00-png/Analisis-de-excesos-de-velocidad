import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];

const USER_AGENT = 'PuntosEnCarretera/1.0 (Geospatial Road Validator)';

// Lightweight in-memory LRU caches
const overpassCache = new Map<string, { ts: number; data: unknown }>();
const tileCache = new Map<string, { ts: number; contentType: string; buf: Buffer }>();

function pruneCache<T>(cache: Map<string, T>, maxEntries: number) {
  if (cache.size <= maxEntries) return;
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // Proxy for Overpass API to avoid browser CORS & rate-limit errors
  app.post('/api/overpass', async (req, res) => {
    const query = String(req.body?.data || req.body?.query || '');
    if (!query) {
      res.status(400).json({ error: 'Missing Overpass query' });
      return;
    }

    const cached = overpassCache.get(query);
    if (cached && Date.now() - cached.ts < 1000 * 60 * 30) {
      res.json(cached.data);
      return;
    }

    let lastError = 'No response from Overpass mirrors';
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const endpoint of OVERPASS_ENDPOINTS) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 45000);
        try {
          const upstream = await fetch(endpoint, {
            method: 'POST',
            signal: ctl.signal,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': USER_AGENT,
            },
            body: 'data=' + encodeURIComponent(query),
          });
          clearTimeout(timer);

          if (!upstream.ok) {
            lastError = `${endpoint} -> HTTP ${upstream.status}`;
            continue;
          }

          const json = await upstream.json();
          overpassCache.set(query, { ts: Date.now(), data: json });
          pruneCache(overpassCache, 120);
          res.json(json);
          return;
        } catch (err) {
          clearTimeout(timer);
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }

    res.status(502).json({ error: `Overpass unavailable: ${lastError}` });
  });

  // Proxy for OSM France raster tiles (adds CORS headers for Canvas pixel analysis)
  app.get('/api/tile/:z/:x/:y', async (req, res) => {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > 20) {
      res.status(400).send('Invalid tile coordinates');
      return;
    }

    const key = `${z}/${x}/${y}`;
    const cached = tileCache.get(key);
    if (cached) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(cached.buf);
      return;
    }

    const sub = 'abc'.charAt(Math.abs(x + y) % 3);
    const urls = [
      `https://${sub}.tile.openstreetmap.fr/osmfr/${z}/${x}/${y}.png`,
      `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    ];

    for (const url of urls) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      try {
        const upstream = await fetch(url, {
          signal: ctl.signal,
          headers: { 'User-Agent': USER_AGENT },
        });
        clearTimeout(timer);
        if (!upstream.ok) continue;

        const arrayBuf = await upstream.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        const contentType = upstream.headers.get('content-type') || 'image/png';

        tileCache.set(key, { ts: Date.now(), contentType, buf });
        pruneCache(tileCache, 600);

        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
        return;
      } catch {
        clearTimeout(timer);
      }
    }

    res.status(502).send('Tile fetch failed');
  });

  if (process.env.NODE_ENV !== 'production') {
    const vitePromise = createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : undefined,
      },
      appType: 'spa',
    });

    app.use(async (req, res, next) => {
      try {
        const vite = await vitePromise;
        vite.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
