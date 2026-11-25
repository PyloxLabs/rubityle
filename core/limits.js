'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const state = require('./state');
const { getServerDiskUsage, computeCpuPercent, memoryUsageBytes, formatMB, ANSI_RED, ANSI_YELLOW, ANSI_RESET, CONSOLE_TAG } = require('../utils');

// Limits are the panel's source of truth. They are pushed on every start/restart,
// every stats poll, and by a periodic panel sync. Persisted so the monitor keeps
// working across daemon restarts even if a container predates the limit labels.
const limitsFile = path.join(config.dataDir, 'server_limits.json');
let limitsCache = null;

function loadLimits() {
  if (limitsCache) return limitsCache;
  try { limitsCache = JSON.parse(fs.readFileSync(limitsFile, 'utf8')) || {}; } catch (_) { limitsCache = {}; }
  return limitsCache;
}

function applyServerLimits(uuid, limits) {
  if (!uuid || !limits) return;
  const clean = {};
  for (const key of ['memory', 'cpu', 'disk']) {
    if (limits[key] !== undefined && limits[key] !== null && limits[key] !== '') {
      clean[key] = parseInt(limits[key], 10) || 0;
    }
  }
  if (!Object.keys(clean).length) return;

  // Only touch known servers so we never inject phantom entries; the values are
  // still persisted and merged in when the container is discovered/created.
  const info = state.servers.get(uuid);
  if (info) Object.assign(info, clean);

  const store = loadLimits();
  const merged = Object.assign({}, store[uuid], clean);
  if (JSON.stringify(merged) !== JSON.stringify(store[uuid] || {})) {
    store[uuid] = merged;
    try { fs.writeFileSync(limitsFile, JSON.stringify(store)); } catch (_) { /* ignore */ }
  }
}

function mergePersistedLimits(uuid, info) {
  const persisted = loadLimits()[uuid];
  if (persisted) Object.assign(info, persisted);
  return info;
}

function markViolation(uuid, resource) {
  const timers = state.limitTimers.get(uuid) || {};
  if (timers[resource] === undefined) timers[resource] = Date.now();
  state.limitTimers.set(uuid, timers);
  return Date.now() - timers[resource];
}

function clearViolation(uuid, resource) {
  const timers = state.limitTimers.get(uuid);
  if (timers && timers[resource] !== undefined) delete timers[resource];
}

function diskBlockedMessage(uuid) {
  const b = state.diskBlocked.get(uuid) || {};
  return `Server cannot be started: disk usage (${b.usedMB || 0} MB) is at or above the ${b.limitMB || 0} MB limit. Free up space first.`;
}

async function enforceResourceLimit(uuid, resource, detail) {
  clearViolation(uuid, resource);
  const minutes = Math.max(1, Math.round(config.resourceLimitGraceMs / 60000));
  let reason;
  if (resource === 'memory') reason = `memory limit exceeded (${detail.usedMB} / ${detail.limitMB} MB) for over ${minutes} minutes`;
  else if (resource === 'cpu') reason = `CPU limit exceeded (${detail.usedPct}% / ${detail.limitPct}%) for over ${minutes} minutes`;
  else reason = `disk limit exceeded (${detail.usedMB} / ${detail.limitMB} MB) for over ${minutes} minutes`;

  state.pushSystemConsole(uuid, `${ANSI_RED}[Pylox]${ANSI_RESET} Killing server: ${reason}.`);
  logger.warn(`Resource limit enforcement for ${uuid}: ${reason}`);

  const container = require('./docker').getContainer(uuid);
  state.markIntentionalStop(uuid);
  try {
    await container.kill();
  } catch (err) {
    const { isNotRunning } = require('./power');
    if (!isNotRunning(err)) logger.warn(`Could not kill ${uuid}: ${err.message}`);
  }
  require('./console').detachConsole(uuid);
  state.setStatus(uuid, state.STATUS.OFFLINE);

  if (resource === 'disk') {
    state.setDiskBlocked(uuid, { usedMB: detail.usedMB, limitMB: detail.limitMB });
    state.pushSystemConsole(uuid, `${ANSI_YELLOW}[Pylox]${ANSI_RESET} The server cannot be started until disk usage is below the ${detail.limitMB} MB limit.`);
  }
}

async function evaluateServerLimits(uuid, info) {
  const diskLimitMB = Number(info.disk) || 0;
  const memLimitMB = Number(info.memory) || 0;
  const cpuLimit = Number(info.cpu) || 0;

  let running = false;
  try {
    const inspect = await require('./docker').getContainer(uuid).inspect();
    running = !!inspect.State.Running;
  } catch (_) { running = false; }

  // Disk is checked whether or not the container is running so that a stopped,
  // over-quota server stays locked out and unlocks the moment it is cleaned up.
  if (diskLimitMB > 0) {
    const diskMB = formatMB(getServerDiskUsage(uuid));
    if (diskMB >= diskLimitMB) {
      const wasBlocked = state.isDiskBlocked(uuid);
      state.setDiskBlocked(uuid, { usedMB: diskMB, limitMB: diskLimitMB });
      if (!running) {
        clearViolation(uuid, 'disk');
        if (!wasBlocked) {
          state.pushSystemConsole(uuid, `${ANSI_YELLOW}[Pylox]${ANSI_RESET} Disk usage (${diskMB} / ${diskLimitMB} MB) is over the limit; the server cannot be started until it is reduced.`);
        }
      } else {
        const over = markViolation(uuid, 'disk');
        if (over === 0) logger.warn(`${uuid}: disk over limit (${diskMB} / ${diskLimitMB} MB); will stop in ${Math.round(config.resourceLimitGraceMs / 60000)} min`);
        else if (over >= config.resourceLimitGraceMs) {
          await enforceResourceLimit(uuid, 'disk', { usedMB: diskMB, limitMB: diskLimitMB });
          return;
        }
      }
    } else {
      clearViolation(uuid, 'disk');
      if (state.isDiskBlocked(uuid)) {
        state.clearDiskBlocked(uuid);
        state.pushSystemConsole(uuid, `${CONSOLE_TAG} Disk usage is back under the limit (${diskMB} / ${diskLimitMB} MB). The server can be started again.`);
      }
    }
  }

  if (!running) {
    clearViolation(uuid, 'cpu');
    clearViolation(uuid, 'memory');
    return;
  }

  let stats;
  try { stats = await require('./docker').getContainer(uuid).stats({ stream: false }); } catch (_) { return; }

  const cpuPct = computeCpuPercent(stats);
  const memMB = formatMB(memoryUsageBytes(stats));
  const dockerMemLimitMB = stats.memory_stats && stats.memory_stats.limit ? formatMB(stats.memory_stats.limit) : 0;
  const effectiveMemLimitMB = memLimitMB > 0 ? memLimitMB : dockerMemLimitMB;

  if (cpuLimit > 0 && cpuPct >= cpuLimit) {
    const over = markViolation(uuid, 'cpu');
    if (over === 0) logger.warn(`${uuid}: CPU over limit (${Math.round(cpuPct)}% / ${cpuLimit}%); will stop in ${Math.round(config.resourceLimitGraceMs / 60000)} min`);
    else if (over >= config.resourceLimitGraceMs) {
      await enforceResourceLimit(uuid, 'cpu', { usedPct: Math.round(cpuPct), limitPct: cpuLimit });
      return;
    }
  } else {
    clearViolation(uuid, 'cpu');
  }

  if (effectiveMemLimitMB > 0 && memMB >= effectiveMemLimitMB) {
    const over = markViolation(uuid, 'memory');
    if (over === 0) logger.warn(`${uuid}: memory over limit (${memMB} / ${effectiveMemLimitMB} MB); will stop in ${Math.round(config.resourceLimitGraceMs / 60000)} min`);
    else if (over >= config.resourceLimitGraceMs) {
      await enforceResourceLimit(uuid, 'memory', { usedMB: memMB, limitMB: effectiveMemLimitMB });
      return;
    }
  } else {
    clearViolation(uuid, 'memory');
  }
}

let monitorBusy = false;

async function evaluateResourceLimits() {
  if (monitorBusy) return;
  monitorBusy = true;
  try {
    for (const [uuid, info] of state.servers) {
      try {
        await evaluateServerLimits(uuid, info);
      } catch (err) {
        logger.warn(`Resource monitor error for ${uuid}: ${err.message}`);
      }
    }
  } finally {
    monitorBusy = false;
  }
}

function startResourceMonitor() {
  setInterval(evaluateResourceLimits, config.resourceMonitorIntervalMs);
  setTimeout(evaluateResourceLimits, 5000);
  const withLimits = [...state.servers.values()].filter((s) => (Number(s.disk) || 0) > 0 || (Number(s.memory) || 0) > 0 || (Number(s.cpu) || 0) > 0).length;
  logger.info(`Resource monitor active (grace ${Math.round(config.resourceLimitGraceMs / 1000)}s, interval ${Math.round(config.resourceMonitorIntervalMs / 1000)}s, ${withLimits}/${state.servers.size} servers have limits)`);
  if (withLimits === 0 && state.servers.size > 0) {
    logger.warn('No servers reported resource limits; waiting for the panel to sync them (start/restart, stats poll, or periodic sync)');
  }
}

module.exports = { loadLimits, applyServerLimits, mergePersistedLimits, evaluateResourceLimits, startResourceMonitor, diskBlockedMessage };
