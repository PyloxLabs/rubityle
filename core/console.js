'use strict';

const config = require('../config');
const logger = require('../logger');
const state = require('./state');
const { demux, logSince } = require('../utils');

// Short-lived markers for control characters we write to a TTY. Docker echoes
// them back on stdout, which would otherwise show "^C" in the console.
const echoSuppressions = new Map();

// Docker's "start" event, the console WebSocket and power.start() can all ask
// for an attach at the same time. Without deduping the *in-flight* attach, each
// caller opens its own TTY stream and every console line is broadcast twice.
const attaching = new Map();      // uuid -> Promise<stream|null>
const attachGeneration = new Map(); // uuid -> generation counter

function cleanConsoleLine(line) {
  return String(line).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trim();
}

function dropEchoedCommand(uuid, text) {
  const entry = echoSuppressions.get(uuid);
  if (!entry) return text;
  if (Date.now() > entry.until) {
    echoSuppressions.delete(uuid);
    return text;
  }
  // The echo can be wrapped in cursor codes or arrive in a late buffered chunk.
  const filtered = String(text).split('\n').filter((line) => cleanConsoleLine(line) !== entry.value);
  return filtered.join('\n');
}

function doAttach(uuid, generation) {
  const container = require('./docker').getContainer(uuid);
  return container.inspect().then(
    (info) => {
      if (!info.State.Running && info.State.Status !== 'created') return null;
      return new Promise((resolve) => {
        container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true }, (err, stream) => {
          if (err || !stream) {
            if (err) logger.warn(`Could not attach to ${uuid}: ${err.message}`);
            return resolve(null);
          }
          // detachConsole() ran while this attach was in flight. Discard this
          // stream instead of resurrecting a console for a stopped container.
          if (attachGeneration.get(uuid) !== generation) {
            try { stream.destroy(); } catch (_) { /* ignore */ }
            return resolve(null);
          }
          state.attaches.set(uuid, stream);
          stream.on('data', (chunk) => {
            const text = dropEchoedCommand(uuid, demux(chunk));
            if (!text) return;
            state.feedStartupWatch(uuid, text);
            state.broadcastConsole(uuid, text);
          });
          const cleanup = () => {
            if (state.attaches.get(uuid) === stream) {
              state.attaches.delete(uuid);
              try { stream.destroy(); } catch (_) { /* ignore */ }
            }
          };
          stream.on('error', cleanup);
          stream.on('end', cleanup);
          stream.on('close', cleanup);
          resolve(stream);
        });
      });
    },
    () => null,
  );
}

function attachConsole(uuid) {
  if (state.attaches.has(uuid)) return Promise.resolve(state.attaches.get(uuid));
  if (attaching.has(uuid)) return attaching.get(uuid);

  const generation = attachGeneration.get(uuid) || 0;
  const pending = doAttach(uuid, generation);
  attaching.set(uuid, pending);
  const clear = () => { if (attaching.get(uuid) === pending) attaching.delete(uuid); };
  pending.then(clear, clear);
  return pending;
}

function detachConsole(uuid) {
  // Invalidate any attach still being negotiated so it cannot install itself
  // after the detach and leave a second live stream behind.
  attachGeneration.set(uuid, (attachGeneration.get(uuid) || 0) + 1);
  attaching.delete(uuid);
  const stream = state.attaches.get(uuid);
  if (!stream) return;
  state.attaches.delete(uuid);
  try { stream.destroy(); } catch (_) { /* ignore */ }
}

function detachAll() {
  for (const uuid of [...state.attaches.keys()]) detachConsole(uuid);
}

function writeToConsole(uuid, command, options = {}) {
  const stream = state.attaches.get(uuid);
  if (!stream) return false;
  try {
    if (options.suppressEcho) {
      echoSuppressions.set(uuid, { value: String(command).trim(), until: Date.now() + 5000 });
    }
    stream.write(`${command}\n`);
    return true;
  } catch (err) {
    logger.warn(`Could not write to console of ${uuid}: ${err.message}`);
    return false;
  }
}

function readTail(uuid, lines, since) {
  return new Promise((resolve) => {
    const container = require('./docker').getContainer(uuid);
    const opts = { stdout: true, stderr: true, tail: lines || 100 };
    if (since) opts.since = since;
    container.logs(opts, (err, data) => {
      if (err || !data) return resolve('');
      resolve(demux(Buffer.isBuffer(data) ? data : Buffer.from(String(data))));
    });
  });
}

// Starting a container while attached before boot can yield a dead stream on
// some Docker versions, leaving the console silent until the page is reloaded.
// Start first, then (re)attach to the now-running container and backfill the
// boot log so live output keeps streaming without a refresh.
async function startContainerWithConsole(uuid, container) {
  // Detach before start: Docker emits a "start" event that also requests an
  // attach, and we want that in-flight attach to be the one we reuse below.
  detachConsole(uuid);
  try {
    await container.start();
  } catch (err) {
    if (!/already started|is already running|304|409/i.test(err.message)) throw err;
  }
  // Backfill first, then attach. Reading the log after attaching duplicates any
  // lines emitted during that window: once from the live stream and once from
  // the log tail. With this order, a line is either in the backfill or live.
  // Restrict the tail to this run so previous boots of the same container do
  // not pile up in the console on every reconnect.
  let since = null;
  try { since = logSince(await container.inspect()); } catch (_) { /* ignore */ }
  try {
    const history = await readTail(uuid, 200, since);
    if (history) {
      state.feedStartupWatch(uuid, history);
      state.broadcastConsole(uuid, history);
    }
  } catch (_) { /* ignore */ }
  await attachConsole(uuid);
}

module.exports = {
  attachConsole,
  detachConsole,
  detachAll,
  writeToConsole,
  readTail,
  startContainerWithConsole,
};
