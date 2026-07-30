import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function int(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  uploadDir: process.env.UPLOAD_DIR || path.join(rootDir, 'uploads'),
  dataDir: process.env.DATA_DIR || path.join(rootDir, 'data'),

  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  // Only enable behind a reverse proxy you control, otherwise clients can spoof
  // X-Forwarded-For and place themselves on another network.
  trustProxy: process.env.TRUST_PROXY === '1',

  // How long a transfer survives before it is swept, blob and all.
  itemTtlMs: int(process.env.ITEM_TTL_MINUTES, 30) * 60 * 1000,
  sweepIntervalMs: 20 * 1000,

  maxFileBytes: int(process.env.MAX_FILE_MB, 512) * 1024 * 1024,
  maxFilesPerUpload: int(process.env.MAX_FILES_PER_UPLOAD, 20),
  maxItemsPerDevice: int(process.env.MAX_ITEMS_PER_DEVICE, 80),
  maxTextChars: int(process.env.MAX_TEXT_CHARS, 20000),

  // A plate is permanent, so it is also guessable. These blunt plate scanning.
  lookupsPerMinute: int(process.env.LOOKUPS_PER_MINUTE, 20),
  pendingPerSender: int(process.env.PENDING_PER_SENDER, 5),

  // A device keeps its plate this long after it was last seen.
  deviceTtlMs: int(process.env.DEVICE_TTL_DAYS, 30) * 24 * 60 * 60 * 1000
};
