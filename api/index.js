/* Mock Duet 3 (6HC) + DSF API for your UI
 * - Serves BOTH DSF-style (/machine/...) and rr_ legacy endpoints
 * - Parses G-code, simulates progress by printed segments (no fake layers)
 * - CORS enabled
 *
 * Env:
 *   PORT=3001
 *   PRINT_SECONDS=120      // simulate total print duration
 *   START_FILE=/path/file.gcode  // optional autostart
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = Number(process.env.PORT || 3001);
const PRINT_SECONDS = Number(process.env.PRINT_SECONDS || 800);
// const FEED_MM_PER_MIN = 600; // F600 speed target


// In-memory "SD" storage namespace
// Keys look like 'gcodes/filename.gcode' to mimic Duet paths
const files = new Map();

// Current machine/job state
const machine = {
  bootTs: Date.now(),
  state: 'idle', // 'idle' | 'printing' | 'paused' | 'stopped'
  currentTool: 0,
  coords: { xyz: [0, 0, 0], extruders: [0] },
  job: {
    file: null,              // { fileName: 'gcodes/...' }
    fileSize: 0,
    filePosition: 0,         // 0..fileSize
    progress: { completion: 0 }, // 0..1
    startTs: null,
    estDuration: PRINT_SECONDS * 1000
  },
  parsed: null // { path:[{x,y,z,extrude}], endpoints[], zMin,zMax, pMinZ,pMaxZ }
};

// ---------- helpers ----------

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// very lightweight G-code parser (absolute XYZ by default; supports G90/G91, M82/M83, G92 E, G0/G1)
function parseGcodeText(txt) {
  let posAbs = true, eAbs = true;
  let x = null, y = null, z = 0, e = 0;

  const segments = [];
  const lines = txt.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;

    if (/^G90\b/i.test(line)) { posAbs = true; continue; }
    if (/^G91\b/i.test(line)) { posAbs = false; continue; }
    if (/^M82\b/i.test(line)) { eAbs = true; continue; }
    if (/^M83\b/i.test(line)) { eAbs = false; continue; }

    if (/^G92\b/i.test(line)) {
      const mE = /E(-?\d+(?:\.\d+)?)/i.exec(line);
      if (mE) { e = parseFloat(mE[1]); }
      continue;
    }

    if (/^G0?1\b/i.test(line)) {
      const mX = /X(-?\d+(?:\.\d+)?)/i.exec(line);
      const mY = /Y(-?\d+(?:\.\d+)?)/i.exec(line);
      const mZ = /Z(-?\d+(?:\.\d+)?)/i.exec(line);
      const mE = /E(-?\d+(?:\.\d+)?)/i.exec(line);

      let nx = x, ny = y, nz = z, ne = e;

      if (mX) nx = (x === null || posAbs) ? parseFloat(mX[1]) : x + parseFloat(mX[1]);
      if (mY) ny = (y === null || posAbs) ? parseFloat(mY[1]) : y + parseFloat(mY[1]);
      if (mZ) nz = posAbs ? parseFloat(mZ[1]) : z + parseFloat(mZ[1]);
      if (mE) ne = eAbs ? parseFloat(mE[1]) : e + parseFloat(mE[1]);

      // First point priming: we need a previous point to draw a segment
      if (x === null || y === null) {
        x = nx ?? x; y = ny ?? y; z = nz; e = ne;
        continue;
      }

      const moved = (nx !== null && ny !== null && (nx !== x || ny !== y || nz !== z));
      const de = mE ? (ne - e) : 0;
      // Count *all* positive extrusion as printed (no threshold that drops tiny real paths)
      const extrude = mE ? (de > 0) : false;

      if (moved) {
        segments.push({ x1: x, y1: y, z1: z, x2: nx ?? x, y2: ny ?? y, z2: nz, extrude });
      }
      x = nx ?? x; y = ny ?? y; z = nz; e = ne;
    }
  }

  // world-space bbox from ALL segments (for camera)
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const s of segments) {
    minX = Math.min(minX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2);
    minZ = Math.min(minZ, s.z1, s.z2);
    maxX = Math.max(maxX, s.x1, s.x2);
    maxY = Math.max(maxY, s.y1, s.y2);
    maxZ = Math.max(maxZ, s.z1, s.z2);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; minZ = 0; maxX = 10; maxY = 10; maxZ = 0; }

  // printed (extruding) z-range only
  const printed = segments.filter(s => s.extrude);
  let pMinZ = minZ, pMaxZ = maxZ;
  if (printed.length) {
    pMinZ = Math.min(...printed.map(s => Math.min(s.z1, s.z2)));
    pMaxZ = Math.max(...printed.map(s => Math.max(s.z1, s.z2)));
  }

  // Build endpoint list (world coords) in the order we consider "printed path"
  const endpoints = [];
  for (const s of segments) {
    if (s.extrude) endpoints.push({ x: s.x2, y: s.y2, z: s.z2 });
  }

  return {
    segments,
    bbox: { minX, minY, minZ, maxX, maxY, maxZ },
    zMin: minZ, zMax: maxZ,
    pMinZ, pMaxZ,
    endpoints
  };
}

function printedLength(parsed) {
  if (!parsed?.segments?.length) return 0;
  let L = 0;
  for (const s of parsed.segments) {
    if (s.extrude) L += Math.hypot(s.x2 - s.x1, s.y2 - s.y1, s.z2 - s.z1);
  }
  return L;
}
function computeDurationMs(parsed, feed_mm_min = FEED_MM_PER_MIN) {
  const v = Math.max(1e-6, feed_mm_min) / 60; // mm/s
  const L = printedLength(parsed);
  return Math.max(1000, (L / v) * 1000); // at least 1s
}


function setCurrentJobFromText(serverPath, text) {
  files.set(serverPath, text);
  machine.job.file = { fileName: '/' + serverPath }; // UI expects leading slash sometimes
  machine.job.fileSize = Buffer.byteLength(text, 'utf8');
  machine.job.filePosition = 0;
  machine.job.progress.completion = 0;
  machine.parsed = parseGcodeText(text);
}

// Simulate head & progress along printed endpoints
function updateSimulation() {
  const now = Date.now();
  const uptime = Math.floor((now - machine.bootTs) / 1000);
  const st = machine.state;

  if (st === 'printing' && machine.job.startTs && machine.parsed) {
    const elapsed = now - machine.job.startTs;
    // base time fraction
    let t = clamp01(elapsed / machine.job.estDuration);

    // if we have printed endpoints, map progress to their index
    const EP = machine.parsed.endpoints;
    if (EP.length > 1) {
      const idx = Math.floor(t * (EP.length - 1));
      const p = EP[idx];
      // Move head
      machine.coords.xyz = [p.x, p.y, p.z];
      // Align completion & filePosition with printed path
      machine.job.progress.completion = idx / (EP.length - 1);
      machine.job.filePosition = Math.floor(machine.job.progress.completion * machine.job.fileSize);
    } else {
      // No printed paths? Fall back to Z-min and a tiny motion
      machine.coords.xyz = [0, 0, machine.parsed.pMinZ || 0];
      machine.job.progress.completion = t;
      machine.job.filePosition = Math.floor(t * machine.job.fileSize);
    }

    // Finish
    if (elapsed >= machine.job.estDuration) {
      // snap to end once, then immediately restart the same file
      machine.coords.xyz = [machine.parsed.endpoints.at(-1)?.x || 0,
      machine.parsed.endpoints.at(-1)?.y || 0,
      machine.parsed.endpoints.at(-1)?.z || (machine.parsed.pMaxZ || 0)];
      machine.job.progress.completion = 1;
      machine.job.filePosition = machine.job.fileSize;

      // restart
      machine.state = 'printing';
      machine.job.startTs = Date.now();
      machine.job.progress.completion = 0;
      machine.job.filePosition = 0;
    }
  } else if (st === 'idle') {
    // keep Z at min when idle
    if (machine.parsed) {
      machine.coords.xyz[2] = machine.parsed.pMinZ || 0;
    }
  }

  return uptime;
}

// ---------- middleware ----------

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.text({ type: 'application/octet-stream', limit: '200mb' })); // for rr_upload raw
app.use(bodyParser.urlencoded({ extended: true }));

// ---------- DSF-like endpoints (/machine/...) ----------

// GET /machine/status   → normalized object your UI adapter expects
app.get('/machine/status', (req, res) => {
  const uptime = updateSimulation();
  const payload = {
    state: { status: machine.state, heaterFault: false },
    system: { voltage: 24, uptime },
    coords: { xyz: machine.coords.xyz, extruders: [0] },
    currentTool: machine.currentTool,
    job: {
      file: machine.job.file,
      progress: { completion: machine.job.progress.completion },
      filePosition: machine.job.filePosition,
      fileSize: machine.job.fileSize
    },
    heat: { bed: { current: 25, target: 0 }, heaters: [{ current: 25, target: 0 }] },
    fans: []
  };
  res.json(payload);
});

// GET /machine/file/download?name=gcodes/whatever.gcode
app.get('/machine/file/download', (req, res) => {
  const name = (req.query.name || '').replace(/^\/+/, '');
  const txt = files.get(name);
  if (!txt) return res.status(404).send('Not found');
  res.type('text/plain').send(txt);
});

// POST /machine/file/upload (multipart form-data with field 'file')
app.post('/machine/file/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('No file');
  const dest = 'gcodes/' + (req.file.originalname || 'upload.gcode');
  files.set(dest, req.file.buffer.toString('utf8'));
  return res.json({ ok: true, name: '/' + dest });
});

// POST /machine/job/start?file=/gcodes/whatever.gcode
app.post('/machine/job/start', (req, res) => {
  const p = (req.query.file || '').replace(/^\/+/, '');
  const txt = files.get(p);
  if (!txt) return res.status(404).send('File not found');
  machine.state = 'printing';
  machine.job.startTs = Date.now();
  machine.job.progress.completion = 0;
  machine.job.filePosition = 0;
  machine.job.file = { fileName: '/' + p };
  machine.job.fileSize = Buffer.byteLength(txt, 'utf8');
  machine.parsed = parseGcodeText(txt);
  machine.job.estDuration = computeDurationMs(machine.parsed, FEED_MM_PER_MIN);
  return res.json({ ok: true, started: '/' + p });
});

// ---------- Legacy rr_ endpoints (standalone Duet style) ----------

// GET /rr_status?type=3
app.get('/rr_status', (req, res) => {
  const uptime = updateSimulation();
  const map = { idle: 'I', printing: 'P', paused: 'M', stopped: 'S', busy: 'R' };
  const payload = {
    status: map[machine.state] || 'I',
    coords: { xyz: machine.coords.xyz, extr: [0] },
    currentTool: machine.currentTool,
    time: uptime,
    job: {
      file: machine.job.file,
      progress: { completion: machine.job.progress.completion },
      filePosition: machine.job.filePosition,
      fileSize: machine.job.fileSize
    }
  };
  res.json(payload);
});

// GET /rr_download?name=/gcodes/whatever.gcode
app.get('/rr_download', (req, res) => {
  const raw = String(req.query.name || '');
  const name = raw.replace(/^\/+/, '');
  const txt = files.get(name);
  if (!txt) return res.status(404).send('Not found');
  res.type('text/plain').send(txt);
});

// POST /rr_upload?name=/gcodes/whatever.gcode  (raw octet-stream)
app.post('/rr_upload', (req, res) => {
  const raw = String(req.query.name || '');
  const name = raw.replace(/^\/+/, ''); // keep 'gcodes/..'
  if (!name.startsWith('gcodes/')) return res.status(400).send('Must upload to /gcodes/');
  const buf = typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : req.body;
  if (!buf || !buf.length) return res.status(400).send('Empty body');
  files.set(name, buf.toString('utf8'));
  res.type('text/plain').send('ok');
});

// GET /rr_gcode?gcode=M32%20"%2Fgcodes%2Ffile.gcode"
app.get('/rr_gcode', (req, res) => {
  const g = String(req.query.gcode || '');
  const m = /M32\s+"([^"]+)"/i.exec(g);
  if (!m) return res.status(400).send('Unsupported gcode');
  const p = m[1].replace(/^\/+/, '');
  const txt = files.get(p);
  if (!txt) return res.status(404).send('File not found');

  machine.state = 'printing';
  machine.job.startTs = Date.now();
  machine.job.progress.completion = 0;
  machine.job.filePosition = 0;
  machine.job.file = { fileName: '/' + p };
  machine.job.fileSize = Buffer.byteLength(txt, 'utf8');
  machine.parsed = parseGcodeText(txt);

  res.type('text/plain').send('ok'); // Duet returns plain ok
});

// ---------- optional: quick seed from env ----------
(function seedFromEnv() {
  const fp = process.env.START_FILE;
  if (fp && fs.existsSync(fp)) {
    const txt = fs.readFileSync(fp, 'utf8');
    const name = 'gcodes/' + path.basename(fp);
    files.set(name, txt);
    // autostart
    machine.state = 'printing';
    machine.job.startTs = Date.now();
    machine.job.progress.completion = 0;
    machine.job.filePosition = 0;
    machine.job.file = { fileName: '/' + name };
    machine.job.fileSize = Buffer.byteLength(txt, 'utf8');
    machine.parsed = parseGcodeText(txt);
    console.log('[seed] Loaded and started', name);
  }
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock Duet/DSF API listening on http://0.0.0.0:${PORT}`);
});
