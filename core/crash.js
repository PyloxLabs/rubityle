'use strict';

const config = require('../config');
const logger = require('../logger');
const state = require('./state');
const docker = require('./docker');
const power = require('./power');
const { CONSOLE_TAG } = require('../utils');

// How long a "we stopped this on purpose" marker stays valid. A die event
// delayed longer than this is ignored so it cannot swallow a real crash.
const INTENTIONAL_STOP_TTL_MS = 60000;

// A container emits at most one die event per run, but guard against duplicate
// handling so a server can never be started twice by a single exit.
const handling = new Set();

function crashLine(uuid, text) {
  // Crash notices describe a single exit, not a lasting server condition.
  // Stream them to connected clients but keep them out of the replay history,
  // otherwise every later console page load shows old crashes again.
  state.pushSystemConsole(uuid, `${CONSOLE_TAG}: ${text}`, false);
}

// Prefer the Docker die-event attributes (they describe the exit that just
// happened), falling back to the container's last inspect result.
async function readCrashInfo(uuid, event) {
  const attrs = (event && event.Actor && event.Actor.Attributes) || {};
  let exitCode = null;
  if (attrs.exitCode !== undefined && attrs.exitCode !== '') {
    const parsed = Number(attrs.exitCode);
    if (Number.isFinite(parsed)) exitCode = parsed;
  }
  let outOfMemory = /^true$/i.test(String(attrs.oomKilled || ''));

  try {
    const inspect = await docker.getContainer(uuid).inspect();
    if (inspect.State) {
      if (exitCode === null && Number.isFinite(inspect.State.ExitCode)) exitCode = inspect.State.ExitCode;
      if (inspect.State.OOMKilled) outOfMemory = true;
    }
  } catch (_) { /* container may already be gone */ }

  return { exitCode: exitCode === null ? 'unknown' : exitCode, outOfMemory };
}

// Pure decision helper, kept separate so it can be tested without Docker.
function shouldRestart(lastCrashAt, now) {
  if (lastCrashAt === null || !Number.isFinite(lastCrashAt)) return true;
  return now - lastCrashAt >= config.crashRestartCooldownMs;
}

function crashMessages(info, allowRestart) {
  const messages = [
    '---------- Detected server process in a crashed state! ----------',
    `Exit code: ${info.exitCode}`,
    `Out of memory: ${info.outOfMemory ? 'true' : 'false'}`,
  ];
  if (allowRestart) {
    messages.push('Updating process configuration files...');
    messages.push('Ensuring file permissions are set correctly, this could take a few seconds...');
  } else {
    const seconds = Math.round(config.crashRestartCooldownMs / 1000);
    messages.push(`Aborting automatic restart, last crash occurred less than ${seconds} seconds ago.`);
  }
  return messages;
}

async function handleContainerExit({ uuid, event } = {}) {
  if (!uuid || handling.has(uuid)) return;
  handling.add(uuid);
  try {
    if (state.consumeIntentionalStop(uuid, INTENTIONAL_STOP_TTL_MS)) return;

    const info = await readCrashInfo(uuid, event);
    const now = Date.now();
    const previousCrashAt = state.recordCrash(uuid, now);
    const allowRestart = shouldRestart(previousCrashAt, now);

    logger.warn(`Server ${uuid} crashed (exit ${info.exitCode}, OOM ${info.outOfMemory}); ${allowRestart ? 'restarting' : 'restart aborted'}`);
    for (const message of crashMessages(info, allowRestart)) crashLine(uuid, message);

    if (!allowRestart) return;

    try {
      await power.start(uuid);
    } catch (err) {
      logger.error(`Automatic restart failed for ${uuid}: ${err.message}`);
      crashLine(uuid, `Automatic restart failed: ${err.message}`);
    }
  } finally {
    handling.delete(uuid);
  }
}

module.exports = { handleContainerExit, readCrashInfo, shouldRestart, crashMessages };
