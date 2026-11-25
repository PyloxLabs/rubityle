'use strict';

const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, execFile } = require('child_process');
const config = require('../config');

const ANSI_PURPLE = '\x1b[1m\x1b[35m';
const ANSI_RED = '\x1b[1m\x1b[31m';
const ANSI_YELLOW = '\x1b[1m\x1b[33m';
const ANSI_RESET = '\x1b[0m';
const CONSOLE_TAG = `${ANSI_PURPLE}[Pylox]${ANSI_RESET}`;

function safeEqual(a, b) {
  const left = Buffer.from(String(a == null ? '' : a));
  const right = Buffer.from(String(b == null ? '' : b));
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch (_) {
    return false;
  }
}

function normalizeEnv(env) {
  const out = [];
  for (const entry of env || []) {
    if (entry == null) continue;
    if (typeof entry === 'string') {
      out.push(entry);
    } else if (entry.key !== undefined && entry.key !== null) {
      out.push(`${entry.key}=${entry.value == null ? '' : entry.value}`);
    }
  }
  return out;
}

function dedupeEnv(list) {
  const map = new Map();
  for (const item of list) {
    const idx = item.indexOf('=');
    const key = idx >= 0 ? item.slice(0, idx) : item;
    map.set(key, item);
  }
  return Array.from(map.values());
}

function envToMap(list) {
  const map = {};
  for (const item of list) {
    const idx = item.indexOf('=');
    if (idx > 0) map[item.slice(0, idx)] = item.slice(idx + 1);
  }
  return map;
}

function renderStartup(startup, envMap) {
  return String(startup || '').replace(/\r/g, '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(envMap, key) ? envMap[key] : ''
  ));
}

// Resolve {{VAR}} and legacy {{.VAR}} placeholders inside an egg install
// script, mirroring the real Pterodactyl Panel's InstallerScriptTransformer.
// Plain $VAR references are left untouched for the shell to expand. Scripts
// pasted/edited on Windows often carry CRLF line endings which break POSIX
// shells ("unexpected fi (expecting then)"), so normalize them here.
function substituteInstallScript(text, envMap) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  return normalized.replace(/\{\{\s*\.?([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(envMap, key) ? String(envMap[key]) : ''
  ));
}

function isValidImageRef(image) {
  if (!image || typeof image !== 'string') return false;
  const value = image.trim();
  if (!value || /\s/.test(value)) return false;
  if (/[A-Z]/.test(value)) return false;
  return /^[a-z0-9._/-]+(:[a-zA-Z0-9._-]+)?(@sha256:[a-f0-9]+)?$/.test(value);
}

function configHash(parts) {
  const normalized = {
    name: parts.name || '',
    image: parts.image || '',
    env: (parts.env || []).slice().sort(),
    memory: parts.memory || 0,
    swap: parts.swap || 0,
    cpu: parts.cpu || 0,
    io: parts.io || 0,
    disk: parts.disk || 0,
    ports: parts.ports || [],
    startup: parts.startup || '',
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

function demux(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  if ((buffer[0] === 0 || buffer[0] === 1 || buffer[0] === 2) && buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 0) {
    const chunks = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(offset + 4);
      if (offset + 8 + size > buffer.length) break;
      chunks.push(buffer.slice(offset + 8, offset + 8 + size).toString('utf8'));
      offset += 8 + size;
    }
    return chunks.join('');
  }
  return buffer.toString('utf8');
}

// The yolks images bake a hardcoded prompt into their entrypoint scripts:
//   printf "\033[1m\033[33mcontainer@pterodactyl~ \033[0m%s\n" "$PARSED"
// Rebrand it to "container@pylox~" and recolor it purple so the console no
// longer shows Pterodactyl branding.
function brandConsole(text) {
  let out = String(text || '').replace(/container@pterodactyl/g, 'container@pylox');
  out = out.replace(/\x1b\[1m\x1b\[33mcontainer@pylox~ \x1b\[0m/g, `${ANSI_PURPLE}container@pylox~ ${ANSI_RESET}`);
  return out;
}

function getDiskInfo() {
  const target = fs.existsSync(config.dataDir) ? config.dataDir : '/';
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(target);
      const unit = s.frsize || s.bsize || 1024;
      return { total_disk: s.blocks * unit, free_disk: (s.bavail || s.bfree) * unit };
    }
  } catch (_) { /* fall through */ }

  try {
    const out = execSync(`df -kP "${target}" 2>/dev/null | tail -n 1`).toString().trim();
    const parts = out.split(/\s+/);
    if (parts.length >= 4) {
      return { total_disk: parseInt(parts[1], 10) * 1024, free_disk: parseInt(parts[3], 10) * 1024 };
    }
  } catch (_) { /* ignore */ }

  return { total_disk: 0, free_disk: 0 };
}

const diskUsageCache = new Map();
const DISK_USAGE_TTL_MS = 60000;

// Approximate the on-disk footprint of a server's home directory.
//
// `du` over a Minecraft world can take seconds, and it used to run on the
// event loop: every HTTP request to the daemon (including the panel's stats
// polls) stalled until it finished, the panel's 1.5s stats timeout fired, and
// the console showed the "Reconnecting to node" banner against a perfectly
// healthy node. A restart made this hit every time because stop/start clear
// the cache. Now the last known value is returned immediately and the walk
// runs in the background.
function scheduleDiskUsageRefresh(uuid) {
  const existing = diskUsageCache.get(uuid);
  if (existing && existing.refreshing) return;
  const entry = existing || { bytes: 0, at: 0, refreshing: false };
  entry.refreshing = true;
  diskUsageCache.set(uuid, entry);

  const dir = config.serverDir(uuid);
  let dirExists = false;
  try { dirExists = fs.existsSync(dir); } catch (_) { dirExists = false; }
  if (!dirExists) {
    diskUsageCache.set(uuid, { bytes: 0, at: Date.now(), refreshing: false });
    return;
  }

  let done = false;
  const finish = (bytes) => {
    if (done) return;
    done = true;
    const live = diskUsageCache.get(uuid) || { bytes: entry.bytes, at: 0, refreshing: false };
    if (typeof bytes === 'number') live.bytes = bytes;
    live.at = Date.now();
    live.refreshing = false;
    diskUsageCache.set(uuid, live);
  };

  execFile('du', ['-sk', dir], { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err) return finish(null);
    const kb = parseInt(String(stdout).trim().split(/\s+/)[0], 10);
    finish(Number.isFinite(kb) ? kb * 1024 : null);
  });
}

function getServerDiskUsage(uuid) {
  let entry = diskUsageCache.get(uuid);
  if (!entry) {
    entry = { bytes: 0, at: 0, refreshing: false };
    diskUsageCache.set(uuid, entry);
  }
  if (!entry.refreshing && Date.now() - entry.at >= DISK_USAGE_TTL_MS) {
    scheduleDiskUsageRefresh(uuid);
  }
  return entry.bytes;
}

function clearDiskUsageCache(uuid) {
  if (uuid) {
    // Invalidate the timestamp but keep the last measured value: the caller
    // just wants a fresh number soon, not a 0-flash in the UI while the
    // background walk runs.
    const entry = diskUsageCache.get(uuid);
    diskUsageCache.set(uuid, {
      bytes: entry ? entry.bytes : 0,
      at: 0,
      refreshing: entry ? !!entry.refreshing : false,
    });
  } else {
    diskUsageCache.clear();
  }
}

// CPU usage as a percentage where 100 === one fully-used core (matches how the
// panel expresses CPU limits).
function computeCpuPercent(stats) {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const onlineCpus = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage || []).length || os.cpus().length || 1;
    if (systemDelta > 0 && cpuDelta > 0) return (cpuDelta / systemDelta) * onlineCpus * 100;
  } catch (_) { /* ignore */ }
  return 0;
}

// Resident memory usage in bytes, excluding reclaimable page cache so a busy
// cache doesn't look like a genuine over-limit condition.
function memoryUsageBytes(stats) {
  const m = stats && stats.memory_stats;
  if (!m) return 0;
  let used = m.usage || 0;
  const st = m.stats || {};
  const cache = st.inactive_file || st.total_inactive_file || st.cache || 0;
  if (cache > 0 && cache < used) used -= cache;
  return used;
}

// Docker reports StartedAt as "0001-01-01T00:00:00Z" for containers that have
// never been started. Return null for that sentinel so callers never compute
// uptime from a year-1 timestamp.
function sanitizeStartedAt(startedAt) {
  if (!startedAt || typeof startedAt !== 'string') return null;
  const t = new Date(startedAt).getTime();
  if (!t || t <= 0) return null;
  return startedAt;
}

// Docker's logs "since" argument is in whole seconds. Deriving it from the
// current run's StartedAt keeps old boots of the same container out of the
// console history replay.
function logSince(inspect) {
  const startedAt = inspect && inspect.State && inspect.State.StartedAt;
  if (!startedAt || typeof startedAt !== 'string') return null;
  const t = new Date(startedAt).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.floor(t / 1000) - 1;
}

function formatMB(bytes) {
  return Math.round((Number(bytes) || 0) / 1024 / 1024);
}

module.exports = {
  ANSI_PURPLE,
  ANSI_RED,
  ANSI_YELLOW,
  ANSI_RESET,
  CONSOLE_TAG,
  safeEqual,
  normalizeEnv,
  dedupeEnv,
  envToMap,
  renderStartup,
  substituteInstallScript,
  isValidImageRef,
  configHash,
  demux,
  brandConsole,
  getDiskInfo,
  getServerDiskUsage,
  clearDiskUsageCache,
  computeCpuPercent,
  memoryUsageBytes,
  sanitizeStartedAt,
  logSince,
  formatMB,
};
