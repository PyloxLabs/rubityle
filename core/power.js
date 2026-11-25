'use strict';

const config = require('../config');
const logger = require('../logger');
const state = require('./state');
const docker = require('./docker');
const consoleMod = require('./console');
const { fixServerOwnership } = require('./ownership');
const { clearDiskUsageCache } = require('../utils');

// Docker's own status codes/messages, so "already stopped" is never a 500.
function isNotFound(err) {
  if (!err) return false;
  return err.statusCode === 404 || /no such container|not found/i.test(err.message || '');
}

function isNotRunning(err) {
  if (!err) return false;
  return err.statusCode === 304 || err.statusCode === 409
    || /not running|already stopped|already exited/i.test(err.message || '');
}

function diskBlockedError(uuid) {
  const b = state.diskBlocked.get(uuid) || {};
  const err = new Error(`Server cannot be started: disk usage (${b.usedMB || 0} MB) is at or above the ${b.limitMB || 0} MB limit. Free up space first.`);
  err.statusCode = 409;
  err.code = 'disk_limit_blocked';
  err.used_mb = b.usedMB || 0;
  err.limit_mb = b.limitMB || 0;
  return err;
}

// Node.js (and similar) eggs commonly use "^C" or "SIGINT" as their stop
// command. Writing "^C" to the console only works while an attach stream is
// alive; when it does not reach the process, stop() falls through to Docker's
// 20s SIGTERM timeout. Sending the signal directly avoids that long wait.
function signalFromStopCommand(command) {
  const value = String(command || '').trim();
  if (/^\^c$/i.test(value) || /^sigint$/i.test(value)) return 'SIGINT';
  return null;
}

// After any start attempt, re-inspect the container a moment later. A server
// that crashes during boot must never be left advertised as running.
function confirmStart(uuid, container) {
  setTimeout(async () => {
    try {
      const inspect = await container.inspect();
      if (inspect.State.Running) {
        if (!state.isStarting(uuid)) state.setStatus(uuid, state.STATUS.RUNNING);
      } else if (state.getStatus(uuid) === state.STATUS.STARTING) {
        state.setStatus(uuid, state.STATUS.OFFLINE);
      }
    } catch (_) {
      state.setStatus(uuid, state.STATUS.NOT_CREATED);
    }
  }, 750);
}

// Apply a config rebuild that was deferred while the container was running.
async function applyPendingRecreate(uuid) {
  const info = state.getServer(uuid);
  if (!info || !info.pendingConfig) return null;
  const pending = info.pendingConfig;
  logger.info(`Applying deferred configuration rebuild for ${uuid}`);
  const result = await docker.ensureContainer(pending);
  // Only drop the pending config once the replacement container exists. If the
  // rebuild fails, the next start must retry instead of booting stale bindings.
  info.pendingConfig = null;
  return result;
}

async function start(uuid) {
  if (state.isDiskBlocked(uuid)) throw diskBlockedError(uuid);
  // Root-run install containers can leave .npm/node_modules owned by root;
  // hand them back before npm runs as the container user.
  fixServerOwnership(uuid);

  const info = state.getServer(uuid);
  if (!info) {
    const err = new Error('Container is not provisioned on this node');
    err.statusCode = 404;
    err.code = 'not_created';
    throw err;
  }

  // Docker must never auto-restart behind the daemon's back: crash messages
  // and the 60-second cooldown only work when this node owns the restart.
  await docker.disableRestartPolicy(uuid);

  let inspect;
  try {
    inspect = await docker.getContainer(uuid).inspect();
  } catch (err) {
    if (isNotFound(err)) {
      const e = new Error('Container is not provisioned on this node');
      e.statusCode = 404;
      e.code = 'not_created';
      throw e;
    }
    throw err;
  }

  if (inspect.State.Running) {
    await consoleMod.attachConsole(uuid);
    if (!state.isStarting(uuid)) state.setStatus(uuid, state.STATUS.RUNNING);
    return { status: state.getStatus(uuid) };
  }

  // A legacy container may still be mid-restart from Docker's old policy.
  // Adopt it instead of racing a restart that is already in progress.
  if (inspect.State.Restarting || inspect.State.Status === 'restarting') {
    await consoleMod.attachConsole(uuid);
    state.setStatus(uuid, state.STATUS.STARTING);
    state.beginStartupWatch(uuid, info.startupDonePattern, config.startupTimeoutMs);
    return { status: state.getStatus(uuid) };
  }

  // Config changed while stopped: rebuild before boot. A failed rebuild must
  // surface as a failed start; booting the old container would leave the server
  // bound to the previous IP/ports despite the panel showing the new allocation.
  if (info.pendingConfig) await applyPendingRecreate(uuid);

  const container = docker.getContainer(uuid);
  const hasStartupWatch = !!info.startupDonePattern;
  if (hasStartupWatch) {
    state.setStatus(uuid, state.STATUS.STARTING);
    state.beginStartupWatch(uuid, info.startupDonePattern, config.startupTimeoutMs);
  } else {
    state.setStatus(uuid, state.STATUS.STARTING);
    state.beginStartupWatch(uuid, null, config.startupTimeoutMs);
  }

  try {
    await consoleMod.startContainerWithConsole(uuid, container);
  } catch (err) {
    state.cancelStartupWatch(uuid);
    state.setStatus(uuid, state.STATUS.OFFLINE);
    throw err;
  }

  confirmStart(uuid, container);
  return { status: state.getStatus(uuid) };
}

// Stop must be lenient: a missing or already-stopped container is a successful
// stop, not an error, so the panel can always bring a server down cleanly.
async function stop(uuid) {
  const container = docker.getContainer(uuid);
  let inspect;
  try {
    inspect = await container.inspect();
  } catch (err) {
    if (isNotFound(err)) {
      state.setStatus(uuid, state.STATUS.NOT_CREATED);
      return { status: state.STATUS.NOT_CREATED };
    }
    throw err;
  }

  // A crash-looping container reports Running=false but Restarting=true —
  // Docker's restart policy will bring it right back unless we stop it, so
  // this case must fall through to an actual stop() call.
  const restarting = !!inspect.State.Restarting || inspect.State.Status === 'restarting';
  if (!inspect.State.Running && !restarting) {
    consoleMod.detachConsole(uuid);
    state.setStatus(uuid, state.STATUS.OFFLINE);
    return { status: state.STATUS.OFFLINE };
  }

  // From here on the exit is ours (egg stop command or Docker stop) and must
  // not be reported as a crash by the die-event handler.
  state.markIntentionalStop(uuid);

  // Give the egg's stop command a chance to run so worlds save cleanly.
  // Only when the container is actually up (not between crash restarts).
  const info = state.getServer(uuid);
  const stopCommand = info && info.stopCommand ? String(info.stopCommand).trim() : '';
  const signal = signalFromStopCommand(stopCommand);

  const finishStopped = () => {
    consoleMod.detachConsole(uuid);
    clearDiskUsageCache(uuid);
    state.setStatus(uuid, state.STATUS.OFFLINE);
    return { status: state.STATUS.OFFLINE };
  };
  const waitForExit = async (deadline, intervalMs) => {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const s = await container.inspect();
        if (!s.State.Running) return finishStopped();
      } catch (err) {
        if (isNotFound(err)) return finishStopped();
      }
    }
    return null;
  };

  if (stopCommand && inspect.State.Running && !restarting) {
    if (signal) {
      // "^C" on a TTY reaches the whole foreground process group, which is how
      // Node.js apps normally shut down. Keep that behaviour, but send a direct
      // signal as a fallback for shells that do not forward it.
      if (/^\^c$/i.test(stopCommand)) consoleMod.writeToConsole(uuid, stopCommand, { suppressEcho: true });
      let stopped = await waitForExit(Date.now() + 400, 100);
      if (stopped) return stopped;
      try {
        await container.kill({ signal });
      } catch (err) {
        if (!isNotRunning(err) && !isNotFound(err)) {
          consoleMod.writeToConsole(uuid, stopCommand, { suppressEcho: true });
        }
      }
      // Signal-based eggs exit in well under a second. Waiting the full 10s
      // grace here is what made Node.js restarts take 12-30 seconds.
      stopped = await waitForExit(Date.now() + Math.min(config.stopGraceMs, 1500), 200);
      if (stopped) return stopped;
    } else {
      consoleMod.writeToConsole(uuid, stopCommand);
      const stopped = await waitForExit(Date.now() + config.stopGraceMs, 300);
      if (stopped) return stopped;
    }
  }

  try {
    // t:0 on a restarting container kills the restart loop immediately; a
    // graceful timeout is pointless when the process already crashed. For
    // signal-based eggs, cap the Docker fallback too.
    const timeout = restarting ? 0 : (signal ? Math.min(config.stopTimeoutSeconds, 5) : config.stopTimeoutSeconds);
    await container.stop({ t: timeout });
  } catch (err) {
    if (!isNotRunning(err) && !isNotFound(err)) {
      try {
        await container.kill();
      } catch (killErr) {
        if (!isNotRunning(killErr) && !isNotFound(killErr)) throw killErr;
      }
    }
  }

  consoleMod.detachConsole(uuid);
  clearDiskUsageCache(uuid);
  state.setStatus(uuid, state.STATUS.OFFLINE);
  return { status: state.STATUS.OFFLINE };
}

async function kill(uuid) {
  const container = docker.getContainer(uuid);
  let inspect;
  try {
    inspect = await container.inspect();
  } catch (err) {
    if (isNotFound(err)) {
      state.setStatus(uuid, state.STATUS.NOT_CREATED);
      return { status: state.STATUS.NOT_CREATED };
    }
    throw err;
  }

  // A crash-looping container is "not running" between restarts but Docker
  // will bring it back — kill() must still fire to break the restart loop.
  const restarting = !!inspect.State.Restarting || inspect.State.Status === 'restarting';
  if (!inspect.State.Running && !restarting) {
    consoleMod.detachConsole(uuid);
    state.setStatus(uuid, state.STATUS.OFFLINE);
    return { status: state.STATUS.OFFLINE };
  }

  state.markIntentionalStop(uuid);
  try {
    await container.kill();
  } catch (err) {
    if (!isNotRunning(err) && !isNotFound(err)) throw err;
  }

  consoleMod.detachConsole(uuid);
  clearDiskUsageCache(uuid);
  state.setStatus(uuid, state.STATUS.OFFLINE);
  return { status: state.STATUS.OFFLINE };
}

async function restart(uuid) {
  if (state.isDiskBlocked(uuid)) throw diskBlockedError(uuid);
  await stop(uuid);
  return start(uuid);
}

// Full teardown for DELETE /api/servers/:uuid — container plus every per-uuid
// entry in the shared state maps, so nothing leaks between server IDs.
async function destroy(uuid) {
  const container = docker.getContainer(uuid);
  consoleMod.detachConsole(uuid);
  state.markIntentionalStop(uuid);
  try { await container.stop({ t: 10 }); } catch (_) { /* ignore */ }
  try { await container.remove({ v: true, force: true }); } catch (_) { /* ignore */ }
  state.containers.delete(uuid);
  clearDiskUsageCache(uuid);
  state.removeServerState(uuid);
  try {
    const sftp = require('../sftp/store');
    sftp.removeSftpUser(uuid);
  } catch (_) { /* ignore */ }
}

module.exports = { start, stop, kill, restart, destroy, isNotFound, isNotRunning, diskBlockedError, signalFromStopCommand };
