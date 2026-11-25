'use strict';

const { EventEmitter } = require('events');
const { brandConsole } = require('../utils');

// Server lifecycle statuses. These are the ONLY statuses the daemon ever
// reports to the panel:
//   not_created - no container exists on this node for the server
//   offline     - container exists but is not running
//   starting    - start was requested; waiting for the startup-done line
//   running     - container is up (and startup finished, when detected)
const STATUS = Object.freeze({
  NOT_CREATED: 'not_created',
  OFFLINE: 'offline',
  STARTING: 'starting',
  RUNNING: 'running',
});

const SYSTEM_HISTORY_LIMIT = 100;

// Shared event bus. Modules subscribe instead of importing each other, which
// keeps the dependency graph acyclic (docker events -> state -> console, etc).
const events = new EventEmitter();
events.setMaxListeners(0);

const servers = new Map();    // uuid -> { uuid, name, image, status, memory, cpu, swap, io, disk, createdAt, ... }
const containers = new Map(); // uuid -> dockerode container handle
const attaches = new Map();   // uuid -> live console attach stream
const clients = new Map();    // uuid -> Set<ws>
const limitTimers = new Map();  // uuid -> { cpu|memory|disk: timestamp first exceeded }
const diskBlocked = new Map();  // uuid -> { usedMB, limitMB }
const systemHistory = new Map(); // uuid -> [panel-generated console lines]
const startupWatchers = new Map(); // uuid -> { pattern, buffer, timer }
const intentionalStops = new Map(); // uuid -> { count, at } stops requested by the daemon (not crashes)
const crashTimes = new Map();   // uuid -> timestamp of the most recent crash

function registerServer(uuid, patch) {
  const existing = servers.get(uuid);
  const info = Object.assign(existing || {
    uuid,
    name: uuid,
    image: '',
    status: STATUS.OFFLINE,
    memory: 0,
    cpu: 0,
    swap: 0,
    io: 0,
    disk: 0,
    createdAt: new Date(),
  }, patch || {}, { uuid });
  servers.set(uuid, info);
  return info;
}

function getServer(uuid) {
  return servers.get(uuid) || null;
}

function getStatus(uuid) {
  const info = servers.get(uuid);
  return info ? info.status : STATUS.NOT_CREATED;
}

function removeServerState(uuid) {
  servers.delete(uuid);
  containers.delete(uuid);
  attaches.delete(uuid);
  clients.delete(uuid);
  limitTimers.delete(uuid);
  diskBlocked.delete(uuid);
  systemHistory.delete(uuid);
  intentionalStops.delete(uuid);
  crashTimes.delete(uuid);
  cancelStartupWatch(uuid);
}

function broadcast(uuid, payload) {
  const set = clients.get(uuid);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      try { ws.send(data); } catch (_) { /* ignore */ }
    }
  }
}

// Single choke-hole for status changes. Anything that wants to move a server
// between states goes through here so cached info and console subscribers can
// never disagree with each other.
function setStatus(uuid, status) {
  const info = servers.get(uuid);
  if (!info || info.status === status) return;
  info.status = status;
  if (status !== STATUS.STARTING) cancelStartupWatch(uuid);
  broadcast(uuid, { event: 'status', status });
  events.emit('status', { uuid, status, previous: info.status });
}

function addClient(uuid, ws) {
  if (!clients.has(uuid)) clients.set(uuid, new Set());
  clients.get(uuid).add(ws);
}

function removeClient(uuid, ws) {
  const set = clients.get(uuid);
  if (set) set.delete(ws);
}

function broadcastConsole(uuid, text) {
  if (!text) return;
  broadcast(uuid, { event: 'console', data: brandConsole(text) });
}

// Panel-generated console lines (resource-limit events, etc.) are kept in a
// small per-server ring buffer so they survive a page refresh / reconnect,
// since they do not exist in the container's own Docker log. Transient notices
// (crash reports) pass persist=false: they go to whoever is watching now, but
// are not replayed on every later console connection.
function pushSystemConsole(uuid, text, persist = true) {
  if (!text) return;
  const line = text.endsWith('\n') ? text : `${text}\n`;
  if (persist) {
    const arr = systemHistory.get(uuid) || [];
    arr.push(line);
    while (arr.length > SYSTEM_HISTORY_LIMIT) arr.shift();
    systemHistory.set(uuid, arr);
  }
  broadcastConsole(uuid, line);
}

function getSystemHistory(uuid) {
  return systemHistory.get(uuid) || [];
}

// ─── Startup detection ──────────────────────────────────────────────
// A server whose egg defines a startup-done line stays "starting" until that
// line appears in its console output (or the watchdog times out). This is what
// stops a server that crashes a few milliseconds after boot from being
// advertised as "running".
function beginStartupWatch(uuid, pattern, timeoutMs) {
  cancelStartupWatch(uuid);
  const watcher = { pattern: pattern || null, buffer: '', timer: null };
  if (timeoutMs > 0) {
    watcher.timer = setTimeout(() => {
      startupWatchers.delete(uuid);
      if (getStatus(uuid) === STATUS.STARTING) setStatus(uuid, STATUS.RUNNING);
    }, timeoutMs);
    if (watcher.timer.unref) watcher.timer.unref();
  }
  startupWatchers.set(uuid, watcher);
}

function cancelStartupWatch(uuid) {
  const watcher = startupWatchers.get(uuid);
  if (!watcher) return;
  if (watcher.timer) clearTimeout(watcher.timer);
  startupWatchers.delete(uuid);
}

// Feed console output through the startup watcher. Returns true when this
// chunk completed the startup sequence.
function feedStartupWatch(uuid, text) {
  const watcher = startupWatchers.get(uuid);
  if (!watcher || !text) return false;
  watcher.buffer = (watcher.buffer + text).slice(-4096);
  if (watcher.pattern && watcher.pattern.test(watcher.buffer)) {
    if (watcher.timer) clearTimeout(watcher.timer);
    startupWatchers.delete(uuid);
    setStatus(uuid, STATUS.RUNNING);
    return true;
  }
  return false;
}

function isStarting(uuid) {
  return startupWatchers.has(uuid);
}

// ─── Disk-block bookkeeping ─────────────────────────────────────────
function isDiskBlocked(uuid) {
  return diskBlocked.has(uuid);
}

function setDiskBlocked(uuid, detail) {
  diskBlocked.set(uuid, detail);
}

function clearDiskBlocked(uuid) {
  diskBlocked.delete(uuid);
}

// ─── Crash bookkeeping ───────────────────────────────────────────────
// Stops/kills issued by the daemon itself must not be mistaken for crashes.
// The marker expires so a stale flag can never swallow a later real crash.
function markIntentionalStop(uuid) {
  const entry = intentionalStops.get(uuid) || { count: 0, at: 0 };
  entry.count += 1;
  entry.at = Date.now();
  intentionalStops.set(uuid, entry);
}

function consumeIntentionalStop(uuid, maxAgeMs) {
  const entry = intentionalStops.get(uuid);
  if (!entry) return false;
  if (maxAgeMs > 0 && Date.now() - entry.at > maxAgeMs) {
    intentionalStops.delete(uuid);
    return false;
  }
  if (entry.count <= 1) intentionalStops.delete(uuid);
  else { entry.count -= 1; intentionalStops.set(uuid, entry); }
  return true;
}

function clearIntentionalStop(uuid) {
  intentionalStops.delete(uuid);
}

// Returns the timestamp of the previous crash, or null when this is the first
// one recorded for the server (or state was cleared).
function recordCrash(uuid, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const previous = crashTimes.has(uuid) ? crashTimes.get(uuid) : null;
  crashTimes.set(uuid, at);
  return previous;
}

function getLastCrash(uuid) {
  return crashTimes.has(uuid) ? crashTimes.get(uuid) : null;
}

function clearCrash(uuid) {
  crashTimes.delete(uuid);
}

module.exports = {
  STATUS,
  events,
  servers,
  containers,
  attaches,
  clients,
  limitTimers,
  diskBlocked,
  intentionalStops,
  crashTimes,
  registerServer,
  getServer,
  getStatus,
  setStatus,
  removeServerState,
  broadcast,
  addClient,
  removeClient,
  broadcastConsole,
  pushSystemConsole,
  getSystemHistory,
  beginStartupWatch,
  cancelStartupWatch,
  feedStartupWatch,
  isStarting,
  isDiskBlocked,
  setDiskBlocked,
  clearDiskBlocked,
  markIntentionalStop,
  consumeIntentionalStop,
  clearIntentionalStop,
  recordCrash,
  getLastCrash,
  clearCrash,
};
