import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';

import { config } from './src/config.js';
import { registry } from './src/registry.js';
import { transfers, publicTransfer, newId, EVERYONE } from './src/transfers.js';
import { normalizePlate, PLATE_SHAPE, PLATE_LETTERS } from './src/plates.js';
import { networkKeyForRequest, networkKey, networkLabel, clientIp, lanAddress } from './src/net.js';

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });

/**
 * Transfers live in memory, so nothing in the upload directory can still be
 * referenced once the process restarts. Anything found here is a leftover from
 * a previous run or a crash — drop it rather than let the disk grow forever.
 * Give UPLOAD_DIR a directory of its own; this clears it on every boot.
 */
function sweepOrphanedBlobs() {
  let removed = 0;
  for (const entry of fs.readdirSync(config.uploadDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      fs.unlinkSync(path.join(config.uploadDir, entry.name));
      removed += 1;
    } catch (error) {
      console.error('could not remove orphaned blob', entry.name, error.message);
    }
  }
  if (removed) console.log(`Cleared ${removed} orphaned file${removed === 1 ? '' : 's'} from a previous run`);
}
sweepOrphanedBlobs();

// Download links live in <a href>, which cannot carry an auth header. Instead each
// transfer gets a capability token that is only ever handed to the two parties.
const SERVER_SECRET = crypto.randomBytes(32);
const tokenFor = (id) => crypto.createHmac('sha256', SERVER_SECRET).update(id).digest('base64url').slice(0, 22);
const tokenMatches = (id, token) => {
  const expected = tokenFor(id);
  const given = String(token || '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
};

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => done(null, config.uploadDir),
    // Blobs are stored under an opaque id; the original name only lives in metadata.
    filename: (_req, _file, done) => done(null, newId())
  }),
  limits: { fileSize: config.maxFileBytes, files: config.maxFilesPerUpload }
});

// ---------------------------------------------------------------- identity

const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function requireDevice(req, res, next) {
  const deviceId = String(req.get('x-device-id') || '');
  if (!DEVICE_ID_RE.test(deviceId)) {
    return res.status(401).json({ error: 'This browser has not registered a device yet.' });
  }
  req.device = registry.claim(deviceId, {
    name: String(req.get('x-device-name') || '').slice(0, 40) || undefined,
    networkKey: networkKeyForRequest(req)
  });
  req.networkKey = req.device.networkKey;
  next();
}

// ---------------------------------------------------------------- rate limit

const buckets = new Map();

/** Fixed-window counter. Enough to make plate scanning pointless. */
function overLimit(key, limit, windowMs = 60_000) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key);
}, 60_000).unref?.();

// ---------------------------------------------------------------- sockets

/** @type {Map<string, Set<import('ws').WebSocket>>} deviceId -> sockets */
const sockets = new Map();

function onlineDeviceIds() {
  return [...sockets.keys()];
}

/** Devices with a live socket on the same network, so you rarely have to type a plate. */
function nearbyOf(device) {
  const peers = [];
  for (const deviceId of onlineDeviceIds()) {
    if (deviceId === device.deviceId) continue;
    const other = registry.get(deviceId);
    if (!other || other.networkKey !== device.networkKey) continue;
    if (device.blocked.has(other.plate)) continue;
    peers.push({ ...registry.publicPeer(other), saved: device.peers.has(other.plate) });
  }
  return peers.sort((a, b) => a.name.localeCompare(b.name));
}

/** Attach a download capability only for transfers this viewer may actually open. */
function withToken(transfer, viewerDeviceId) {
  const view = publicTransfer(transfer, viewerDeviceId);
  const openable = transfer.status === 'accepted' || transfer.fromDeviceId === viewerDeviceId;
  if (openable && transfer.status !== 'declined') view.token = tokenFor(transfer.id);
  return view;
}

/**
 * A saved peer can go stale — the other device may have rotated its plate or
 * moved networks. Rather than deleting the entry behind the user's back, mark
 * it so the UI can show it as unreachable and let them remove it.
 */
function annotateSaved(device, self) {
  self.savedPeers = self.savedPeers.map((peer) => {
    const { device: found } = registry.resolve(peer.plate, device.networkKey);
    return {
      ...peer,
      name: found ? found.name : peer.name,
      known: Boolean(found),
      online: Boolean(found && sockets.has(found.deviceId))
    };
  });
  return self;
}

function stateFor(device) {
  return {
    type: 'state',
    self: annotateSaved(device, registry.publicSelf(device)),
    network: { label: networkLabel(device.networkKey) },
    nearby: nearbyOf(device),
    inbox: transfers.inbox(device.deviceId, device.networkKey).map((t) => withToken(t, device.deviceId)),
    sent: transfers.sent(device.deviceId).map((t) => withToken(t, device.deviceId)),
    online: sockets.has(device.deviceId),
    now: Date.now()
  };
}

function pushTo(deviceId) {
  const peers = sockets.get(deviceId);
  if (!peers?.size) return;
  const device = registry.get(deviceId);
  if (!device) return;
  const payload = JSON.stringify(stateFor(device));
  for (const socket of peers) if (socket.readyState === socket.OPEN) socket.send(payload);
}

/** Presence and broadcasts change what everyone on a network sees. */
function pushNetwork(key) {
  for (const deviceId of onlineDeviceIds()) {
    if (registry.get(deviceId)?.networkKey === key) pushTo(deviceId);
  }
}

transfers.on('expired', (expired) => {
  const touched = new Set();
  for (const transfer of expired) {
    touched.add(transfer.fromDeviceId);
    if (transfer.toDeviceId) touched.add(transfer.toDeviceId);
    else pushNetwork(transfer.networkKey);
  }
  for (const deviceId of touched) pushTo(deviceId);
});

// ---------------------------------------------------------------- helpers

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

async function discardUploads(files) {
  await Promise.all((files || []).map((file) => fs.promises.unlink(file.path).catch(() => {})));
}

/**
 * Turns a typed plate into a delivery target, or explains why it cannot.
 * Plates deliberately only resolve inside the sender's own network.
 */
function resolveTarget(device, rawTarget) {
  const wanted = String(rawTarget || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (wanted === EVERYONE) {
    return { broadcast: true };
  }

  const { device: target, error } = registry.resolve(rawTarget, device.networkKey);
  if (error === 'malformed') {
    return { error: `Plates look like ${PLATE_SHAPE}. They never contain I, L, O or U.`, status: 400 };
  }
  if (error === 'unknown' || error === 'other-network') {
    // Both cases answer the same way, so a scanner cannot tell a real plate on
    // another network from one that does not exist.
    return { error: 'No device with that plate is on your network.', status: 404 };
  }
  if (target.deviceId === device.deviceId) {
    return { error: 'That is your own plate.', status: 400 };
  }
  if (target.blocked.has(device.plate)) {
    return { error: 'That device is not accepting transfers from you.', status: 403 };
  }
  return { target };
}

function deliver(device, target, broadcast, record) {
  const trusted = !broadcast && registry.isTrusted(target, device.plate);
  const transfer = transfers.add({
    ...record,
    fromDeviceId: device.deviceId,
    fromPlate: device.plate,
    fromName: device.name,
    toDeviceId: broadcast ? null : target.deviceId,
    toPlate: broadcast ? EVERYONE : target.plate,
    toName: broadcast ? 'Everyone on this network' : target.name,
    networkKey: device.networkKey,
    // Broadcasts are opt-in by the receiver's presence on the network, so they
    // need no consent step. A first contact from an unknown plate does.
    status: broadcast || trusted ? 'accepted' : 'pending'
  });

  if (broadcast) pushNetwork(device.networkKey);
  else pushTo(target.deviceId);
  pushTo(device.deviceId);
  return transfer;
}

// ---------------------------------------------------------------- api

app.get('/api/me', requireDevice, async (req, res) => {
  const lan = lanAddress();
  const joinUrl = lan ? `http://${lan}:${config.port}/` : `${req.protocol}://${req.get('host')}/`;
  let qr = null;
  try {
    qr = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  } catch {
    qr = null;
  }

  res.json({
    ...stateFor(req.device),
    joinUrl,
    yourIp: clientIp(req),
    // Tells the page to stop pretending it works: on serverless there is no
    // shared registry and no socket, so two devices cannot find each other.
    ephemeral: config.serverless,
    plateShape: PLATE_SHAPE,
    plateLetters: PLATE_LETTERS,
    limits: {
      ttlMs: config.itemTtlMs,
      maxFileBytes: config.maxFileBytes,
      maxFilesPerUpload: config.maxFilesPerUpload,
      maxItemsPerDevice: config.maxItemsPerDevice,
      maxTextChars: config.maxTextChars
    },
    qr
  });
});

app.post('/api/lookup', requireDevice, (req, res) => {
  if (overLimit(`lookup:${req.device.deviceId}`, config.lookupsPerMinute)) {
    return res.status(429).json({ error: 'Too many plate lookups. Wait a minute and try again.' });
  }
  const result = resolveTarget(req.device, req.body?.plate);
  if (result.broadcast) return res.json({ target: { plate: EVERYONE, name: 'Everyone on this network' } });
  if (result.error) return res.status(result.status).json({ error: result.error });

  res.json({
    target: {
      ...registry.publicPeer(result.target),
      online: sockets.has(result.target.deviceId),
      saved: req.device.peers.has(result.target.plate)
    }
  });
});

app.post('/api/send', requireDevice, (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Nothing to send.' });
  if (text.length > config.maxTextChars) {
    return res.status(413).json({ error: `Text is limited to ${config.maxTextChars} characters.` });
  }

  const result = resolveTarget(req.device, req.body?.to);
  if (result.error) return res.status(result.status).json({ error: result.error });
  const guard = pendingGuard(req.device, result);
  if (guard) return res.status(429).json({ error: guard });

  const transfer = deliver(req.device, result.target, result.broadcast, { kind: 'text', text });
  res.status(201).json({ transfer: withToken(transfer, req.device.deviceId) });
});

app.post('/api/send-files', requireDevice, upload.array('files', config.maxFilesPerUpload), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files received.' });

  const result = resolveTarget(req.device, req.body?.to);
  if (result.error) {
    await discardUploads(files); // never leave blobs behind for a rejected send
    return res.status(result.status).json({ error: result.error });
  }
  const guard = pendingGuard(req.device, result, files.length);
  if (guard) {
    await discardUploads(files);
    return res.status(429).json({ error: guard });
  }

  const created = files.map((file) =>
    deliver(req.device, result.target, result.broadcast, {
      kind: 'file',
      name: file.originalname || 'file',
      size: file.size,
      mime: file.mimetype || 'application/octet-stream',
      storedPath: file.path
    })
  );
  res.status(201).json({ transfers: created.map((t) => withToken(t, req.device.deviceId)) });
});

/** An unknown sender may only have a few requests waiting before being told to stop. */
function pendingGuard(device, result, incoming = 1) {
  if (result.broadcast) return null;
  if (registry.isTrusted(result.target, device.plate)) return null;
  const waiting = transfers.pendingFrom(device.deviceId, result.target.deviceId);
  if (waiting + incoming > config.pendingPerSender) {
    return `${result.target.name} has not accepted your earlier items yet.`;
  }
  return null;
}

app.post('/api/transfers/:id/accept', requireDevice, (req, res) => {
  const transfer = transfers.get(req.params.id);
  if (!transfer || transfer.toDeviceId !== req.device.deviceId) {
    return res.status(404).json({ error: 'That request is gone.' });
  }

  const accepted = transfers.acceptAllFrom(req.device.deviceId, transfer.fromDeviceId);
  if (req.body?.save) {
    registry.savePeer(req.device, { plate: transfer.fromPlate, name: transfer.fromName });
  }
  pushTo(req.device.deviceId);
  pushTo(transfer.fromDeviceId);
  res.json({ accepted: accepted.length, saved: Boolean(req.body?.save) });
});

app.post('/api/transfers/:id/decline', requireDevice, async (req, res) => {
  const transfer = transfers.get(req.params.id);
  if (!transfer || transfer.toDeviceId !== req.device.deviceId) {
    return res.status(404).json({ error: 'That request is gone.' });
  }

  const declined = await transfers.declineAllFrom(req.device.deviceId, transfer.fromDeviceId);
  if (req.body?.block) registry.block(req.device, transfer.fromPlate);
  pushTo(req.device.deviceId);
  pushTo(transfer.fromDeviceId);
  res.json({ declined: declined.length, blocked: Boolean(req.body?.block) });
});

app.get('/api/transfers/:id/download', (req, res) => {
  const transfer = transfers.get(req.params.id);
  if (!transfer) return res.status(404).send('This item is gone or expired.');
  if (!tokenMatches(transfer.id, req.query.t)) return res.status(403).send('This link is not valid.');
  if (transfer.status === 'declined') return res.status(410).send('This item was declined.');

  if (transfer.kind !== 'file') {
    res.type('text/plain; charset=utf-8');
    return res.send(transfer.text);
  }
  if (!transfer.storedPath || !fs.existsSync(transfer.storedPath)) {
    return res.status(410).send('This file is no longer stored.');
  }
  res.download(transfer.storedPath, transfer.name);
});

app.get('/api/inbox/archive', requireDevice, (req, res) => {
  const files = transfers
    .inbox(req.device.deviceId, req.device.networkKey)
    .filter((t) => t.kind === 'file' && t.status === 'accepted' && t.storedPath && fs.existsSync(t.storedPath));
  if (!files.length) return res.status(404).json({ error: 'There are no files to download.' });

  res.attachment('localshare-inbox.zip');
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (error) => {
    console.error('archive failed', error.message);
    res.destroy();
  });
  archive.pipe(res);

  const used = new Set();
  for (const file of files) {
    let name = path.basename(file.name);
    let attempt = 1;
    while (used.has(name)) {
      const ext = path.extname(name);
      name = `${path.basename(name, ext)} (${attempt++})${ext}`;
    }
    used.add(name);
    archive.file(file.storedPath, { name });
  }
  archive.finalize();
});

app.delete('/api/transfers/:id', requireDevice, async (req, res) => {
  const transfer = transfers.get(req.params.id);
  const mine = transfer && (transfer.fromDeviceId === req.device.deviceId || transfer.toDeviceId === req.device.deviceId);
  if (!mine) return res.status(404).json({ error: 'Already gone.' });

  const counterpart = transfer.fromDeviceId === req.device.deviceId ? transfer.toDeviceId : transfer.fromDeviceId;
  await transfers.remove(transfer.id);
  pushTo(req.device.deviceId);
  if (counterpart) pushTo(counterpart);
  else pushNetwork(transfer.networkKey);
  res.json({ ok: true });
});

app.post('/api/clear', requireDevice, async (req, res) => {
  const scope = req.body?.scope === 'sent' ? 'sent' : 'inbox';
  const removed = await transfers.clear(req.device.deviceId, req.device.networkKey, scope);
  pushTo(req.device.deviceId);
  res.json({ ok: true, removed, scope });
});

app.post('/api/name', requireDevice, (req, res) => {
  registry.rename(req.device, String(req.body?.name || ''));
  pushTo(req.device.deviceId);
  pushNetwork(req.device.networkKey);
  res.json({ name: req.device.name });
});

app.post('/api/plate/rotate', requireDevice, (req, res) => {
  if (overLimit(`rotate:${req.device.deviceId}`, 3, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'You can change your plate a few times per hour.' });
  }
  const plate = registry.rotatePlate(req.device);
  pushTo(req.device.deviceId);
  pushNetwork(req.device.networkKey);
  res.json({ plate });
});

app.post('/api/peers', requireDevice, (req, res) => {
  const result = resolveTarget(req.device, req.body?.plate);
  if (result.broadcast) return res.status(400).json({ error: 'Everyone is not a device.' });
  if (result.error) return res.status(result.status).json({ error: result.error });
  registry.savePeer(req.device, registry.publicPeer(result.target));
  pushTo(req.device.deviceId);
  res.json({ saved: registry.publicPeer(result.target) });
});

app.delete('/api/peers/:plate', requireDevice, (req, res) => {
  const removed = registry.forgetPeer(req.device, normalizePlate(req.params.plate) || req.params.plate);
  pushTo(req.device.deviceId);
  res.json({ ok: removed });
});

app.post('/api/blocked', requireDevice, (req, res) => {
  if (!registry.block(req.device, req.body?.plate)) {
    return res.status(400).json({ error: `Plates look like ${PLATE_SHAPE}.` });
  }
  pushTo(req.device.deviceId);
  res.json({ blocked: [...req.device.blocked] });
});

app.delete('/api/blocked/:plate', requireDevice, (req, res) => {
  registry.unblock(req.device, req.params.plate);
  pushTo(req.device.deviceId);
  res.json({ blocked: [...req.device.blocked] });
});

// Capability link for one item; the token is only ever given to the two parties.
app.get('/s/:id', (req, res) => {
  const transfer = transfers.get(req.params.id);
  if (!transfer || !tokenMatches(req.params.id, req.query.t)) {
    return res
      .status(404)
      .type('html')
      .send(page('Not available', '<p>This link has expired or is not valid.</p>'));
  }
  if (transfer.kind === 'file') {
    return res.redirect(`/api/transfers/${transfer.id}/download?t=${encodeURIComponent(String(req.query.t))}`);
  }

  res.type('html').send(
    page(
      'Shared text',
      `<p class="meta">From ${escapeHtml(transfer.fromPlate)} · ${escapeHtml(transfer.fromName)}</p>
       <pre id="body">${escapeHtml(transfer.text)}</pre>
       <button id="copy" type="button">Copy text</button>
       <script>
         document.getElementById('copy').addEventListener('click', async () => {
           await navigator.clipboard.writeText(document.getElementById('body').textContent);
           document.getElementById('copy').textContent = 'Copied';
         });
       </script>`
    )
  );
});

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · LocalShare</title>
<style>
  :root { color-scheme: dark light; }
  body { margin:0; padding:2.5rem 1.25rem; font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#0b0d12; color:#e6e9ef; }
  main { max-width:44rem; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .5rem; }
  .meta { color:#94a0b8; font-size:.9rem; margin:0 0 1rem; }
  pre { white-space:pre-wrap; word-break:break-word; background:#151922; border:1px solid #232936;
        border-radius:12px; padding:1rem; }
  button { margin-top:1rem; background:#6366f1; color:#fff; border:0; border-radius:10px;
           padding:.6rem 1.1rem; font-size:.95rem; cursor:pointer; }
  a { color:#8b93ff; }
</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}
<p style="margin-top:2rem"><a href="/">Back to LocalShare</a></p></main></body></html>`;
}

app.use(express.static(config.publicDir, { index: 'index.html', maxAge: '1h' }));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `Each file must be under ${formatBytes(config.maxFileBytes)}.`
        : error.code === 'LIMIT_FILE_COUNT'
          ? `Up to ${config.maxFilesPerUpload} files at a time.`
          : 'Upload rejected.';
    return res.status(413).json({ error: message });
  }
  console.error(error);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ---------------------------------------------------------------- server

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();

  const deviceId = url.searchParams.get('deviceId') || '';
  if (!DEVICE_ID_RE.test(deviceId)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }

  const remoteIp = config.trustProxy
    ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
    : req.socket.remoteAddress;
  const device = registry.claim(deviceId, {
    name: (url.searchParams.get('deviceName') || '').slice(0, 40) || undefined,
    networkKey: networkKey(remoteIp)
  });

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.deviceId = device.deviceId;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const { deviceId } = ws;
  if (!sockets.has(deviceId)) sockets.set(deviceId, new Set());
  sockets.get(deviceId).add(ws);
  ws.isAlive = true;

  pushTo(deviceId);
  pushNetwork(registry.get(deviceId)?.networkKey);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    const peers = sockets.get(deviceId);
    peers?.delete(ws);
    if (peers && peers.size === 0) sockets.delete(deviceId);
    pushNetwork(registry.get(deviceId)?.networkKey);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref?.();

const deviceSweep = setInterval(() => registry.sweep(), 60 * 60 * 1000);
deviceSweep.unref?.();

// A serverless invocation must not bind a port; the platform calls the exported
// app directly. Everything above still loads so routes resolve and pages render.
if (!config.serverless) {
  server.listen(config.port, config.host, () => {
    const lan = lanAddress();
    console.log('LocalShare is running');
    console.log(`  this device   http://localhost:${config.port}`);
    if (lan) console.log(`  same Wi-Fi    http://${lan}:${config.port}`);
    console.log(`  plates like   ${PLATE_SHAPE}`);
    console.log(`  items expire  ${Math.round(config.itemTtlMs / 60000)} min`);
  });
}

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(deviceSweep);
  registry.saveNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default app;
