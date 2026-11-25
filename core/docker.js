'use strict';

const Docker = require('dockerode');
const config = require('../config');
const logger = require('../logger');
const state = require('./state');
const { isValidImageRef, configHash, normalizeEnv, dedupeEnv, envToMap, renderStartup } = require('../utils');

const docker = config.useDockerEnv ? new Docker() : new Docker({ socketPath: config.dockerSocket });

let dockerConnected = false;

function isConnected() {
  return dockerConnected;
}

function ping() {
  return docker.ping()
    .then(() => { dockerConnected = true; })
    .catch(() => { dockerConnected = false; });
}

function getContainer(uuid) {
  let container = state.containers.get(uuid);
  if (!container) {
    container = docker.getContainer(config.containerName(uuid));
    state.containers.set(uuid, container);
  }
  return container;
}

function ensureNetwork() {
  return new Promise((resolve, reject) => {
    docker.getNetwork(config.network).inspect((err) => {
      if (!err) return resolve();
      docker.createNetwork({ Name: config.network, Driver: 'bridge' }, (createErr) => {
        if (createErr && !/already exists/i.test(createErr.message)) return reject(createErr);
        resolve();
      });
    });
  });
}

function ensureImage(image) {
  return new Promise((resolve, reject) => {
    docker.getImage(image).inspect((err) => {
      if (!err) return resolve();
      logger.info(`Pulling image ${image} ...`);
      docker.pull(image, (pullErr, stream) => {
        if (pullErr) return reject(pullErr);
        docker.modem.followProgress(stream, (progressErr) => {
          if (progressErr) return reject(progressErr);
          logger.info(`Image pulled: ${image}`);
          resolve();
        });
      });
    });
  });
}

async function createContainer(cfg) {
  await ensureNetwork();

  let image = cfg.image;
  if (!isValidImageRef(image)) image = config.defaultImage;
  await ensureImage(image);

  const environment = dedupeEnv(normalizeEnv(cfg.env));
  const envMap = envToMap(environment);
  const startup = renderStartup(cfg.startup, envMap);
  envMap.STARTUP = startup;
  envMap.SERVER_MEMORY = envMap.SERVER_MEMORY || String(cfg.memory || 0);
  environment.push(`STARTUP=${startup}`);

  const runtimeEnv = dedupeEnv(environment);

  const exposedPorts = {};
  const portBindings = {};
  for (const p of cfg.ports || []) {
    if (!p || p.container === undefined || p.host === undefined) continue;
    const key = `${p.container}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostIp: p.ip || '0.0.0.0', HostPort: String(p.host) }];
  }

  const hostConfig = {
    NetworkMode: config.network,
    Binds: [`${config.serverDir(cfg.uuid)}:${config.containerDir}`],
    PortBindings: portBindings,
    // Restarts are managed by the daemon so a crash can be reported to the
    // console and throttled; Docker's own policy would bypass that cooldown.
    RestartPolicy: { Name: 'no' },
    LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    Tmpfs: { '/tmp': 'rw,exec,nosuid,size=100M' },
    SecurityOpt: ['no-new-privileges'],
    OomKillDisable: false,
  };

  const memory = parseInt(cfg.memory, 10) || 0;
  if (memory > 0) {
    hostConfig.Memory = memory * 1024 * 1024;
    const swap = parseInt(cfg.swap, 10) || 0;
    hostConfig.MemorySwap = swap > 0 ? hostConfig.Memory + swap * 1024 * 1024 : hostConfig.Memory;
  }

  const cpu = parseInt(cfg.cpu, 10) || 0;
  if (cpu > 0) {
    hostConfig.CPUPeriod = 100000;
    hostConfig.CPUQuota = Math.round(cpu * 1000);
  }
  hostConfig.CpuShares = 512;

  const dir = config.serverDir(cfg.uuid);
  const fs = require('fs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const container = await docker.createContainer({
    Image: image,
    name: config.containerName(cfg.uuid),
    Hostname: cfg.uuid,
    Env: runtimeEnv,
    ExposedPorts: exposedPorts,
    WorkingDir: config.containerDir,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Labels: {
      'pylox.daemon': 'true',
      'pylox.server.uuid': cfg.uuid,
      'pylox.server.name': cfg.name || cfg.uuid,
      'pylox.config.hash': configHash(cfg),
      'pylox.limit.memory': String(parseInt(cfg.memory, 10) || 0),
      'pylox.limit.cpu': String(parseInt(cfg.cpu, 10) || 0),
      'pylox.limit.disk': String(parseInt(cfg.disk, 10) || 0),
    },
    HostConfig: hostConfig,
  });

  state.containers.set(cfg.uuid, container);
  state.registerServer(cfg.uuid, {
    name: cfg.name || cfg.uuid,
    image,
    memory: parseInt(cfg.memory, 10) || 0,
    cpu: parseInt(cfg.cpu, 10) || 0,
    swap: parseInt(cfg.swap, 10) || 0,
    io: parseInt(cfg.io, 10) || 0,
    disk: parseInt(cfg.disk, 10) || 0,
  });
  state.setStatus(cfg.uuid, state.STATUS.OFFLINE);
  return container;
}

// Create-or-adopt the container for a server. A running container is NEVER
// destroyed here: if its configuration changed while it is up, the new config
// is stored on the state entry and applied on the next (re)create after the
// server stops. This is what previously made a running server impossible to
// stop cleanly after an env/config edit.
async function ensureContainer(cfg) {
  const name = config.containerName(cfg.uuid);
  let existing = null;
  try {
    existing = await docker.getContainer(name).inspect();
  } catch (_) { /* not found */ }

  const desiredHash = configHash(cfg);
  const info = state.registerServer(cfg.uuid, {
    name: cfg.name || cfg.uuid,
    image: cfg.image,
    memory: parseInt(cfg.memory, 10) || 0,
    cpu: parseInt(cfg.cpu, 10) || 0,
    swap: parseInt(cfg.swap, 10) || 0,
    io: parseInt(cfg.io, 10) || 0,
    disk: parseInt(cfg.disk, 10) || 0,
    startupDonePattern: compileStartupPattern(cfg.startupDone),
    stopCommand: cfg.stopCommand || '',
  });

  if (existing) {
    const existingHash = existing.Config && existing.Config.Labels && existing.Config.Labels['pylox.config.hash'];
    const container = docker.getContainer(existing.Id);
    state.containers.set(cfg.uuid, container);
    await disableRestartPolicy(cfg.uuid);

    if (existingHash === desiredHash) {
      info.pendingConfig = null;
      applyInspectStatus(cfg.uuid, existing);
      return { container, created: false, running: !!existing.State.Running, pendingRecreate: false };
    }

    if (existing.State.Running) {
      // Defer the rebuild: stopping/removing a live container here would make
      // a running server impossible to stop and would drop player sessions.
      info.pendingConfig = cfg;
      applyInspectStatus(cfg.uuid, existing);
      logger.info(`Configuration changed for ${uuid(cfg)}; rebuild deferred until the server stops`);
      return { container, created: false, running: true, pendingRecreate: true };
    }

    // Wait for the old container to be gone before creating the new one with
    // the same name. Otherwise Docker rejects the create with a name conflict,
    // and the server silently keeps its old port/IP bindings after a restart.
    await detachAndRemove(container);
    logger.info(`Recreating container for ${cfg.uuid} (configuration changed)`);
  }

  const container = await createContainer(cfg);
  info.pendingConfig = null;
  return { container, created: true, running: false, pendingRecreate: false };
}

function uuid(cfg) {
  return cfg.uuid;
}

async function detachAndRemove(container) {
  try { await container.remove({ v: false, force: true }); } catch (_) { /* ignore */ }
}

// Containers created by older versions used Docker's "unless-stopped" policy,
// which restarts a crashed process before the daemon can apply its cooldown.
// Normalise the policy on adoption/start so crash handling is authoritative.
async function disableRestartPolicy(uuid) {
  try {
    const container = getContainer(uuid);
    const inspect = await container.inspect();
    const policy = inspect.HostConfig && inspect.HostConfig.RestartPolicy;
    if (!policy || policy.Name === 'no') return;
    await container.update({ RestartPolicy: { Name: 'no' } });
    logger.info(`Disabled Docker restart policy for ${uuid}; daemon now manages restarts`);
  } catch (err) {
    logger.warn(`Could not disable Docker restart policy for ${uuid}: ${err.message}`);
  }
}

// Mirror a Docker inspect result into the cached state without broadcasting a
// status the panel should not see (a container mid-startup stays "starting").
function applyInspectStatus(uuid, inspect) {
  const running = !!(inspect && inspect.State && inspect.State.Running);
  state.registerServer(uuid, {});
  if (running) {
    if (state.getStatus(uuid) !== state.STATUS.STARTING) {
      state.setStatus(uuid, state.STATUS.RUNNING);
    }
  } else {
    state.setStatus(uuid, state.STATUS.OFFLINE);
  }
}

async function refreshStatus(uuid) {
  try {
    const inspect = await getContainer(uuid).inspect();
    applyInspectStatus(uuid, inspect);
    return {
      status: state.getStatus(uuid),
      state: inspect.State.Status,
      running: !!inspect.State.Running,
      startedAt: inspect.State.StartedAt,
      finishedAt: inspect.State.FinishedAt,
      exitCode: inspect.State.ExitCode,
      pid: inspect.State.Pid,
      containerId: inspect.Id,
    };
  } catch (_) {
    state.setStatus(uuid, state.STATUS.NOT_CREATED);
    return { status: state.STATUS.NOT_CREATED, state: 'not_created', running: false };
  }
}

// ─── Discovery + event stream ───────────────────────────────────────
async function discoverServers() {
  try {
    const list = await docker.listContainers({ all: true, filters: { label: ['pylox.daemon=true'] } });
    for (const entry of list) {
      const uuid = entry.Labels && entry.Labels['pylox.server.uuid'];
      if (!uuid) continue;
      const labels = entry.Labels || {};
      const container = docker.getContainer(entry.Id);
      state.containers.set(uuid, container);
      state.registerServer(uuid, {
        name: labels['pylox.server.name'] || uuid,
        image: entry.Image,
        memory: parseInt(labels['pylox.limit.memory'], 10) || 0,
        cpu: parseInt(labels['pylox.limit.cpu'], 10) || 0,
        disk: parseInt(labels['pylox.limit.disk'], 10) || 0,
      });
      // Best-effort migration of pre-existing containers to daemon-managed restarts.
      disableRestartPolicy(uuid);
      if (entry.State === 'running') {
        state.setStatus(uuid, state.STATUS.RUNNING);
        eventsAttach(uuid);
      } else {
        state.setStatus(uuid, state.STATUS.OFFLINE);
      }
      logger.info(`Discovered container: ${uuid} (${entry.State})`);
    }
  } catch (err) {
    logger.warn(`Could not discover containers: ${err.message}`);
  }
}

// Late-bound so state.js stays free of a docker/console dependency cycle.
let eventsAttach = () => {};
function onDiscoverRunning(fn) {
  eventsAttach = fn;
}

function watchDockerEvents() {
  docker.getEvents({ filters: { type: ['container'], label: ['pylox.daemon=true'] } }, (err, stream) => {
    if (err || !stream) {
      logger.warn('Docker event stream unavailable; retrying in 5s');
      setTimeout(watchDockerEvents, 5000);
      return;
    }
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch (_) { continue; }
        handleDockerEvent(event);
      }
    });
    stream.on('error', () => logger.warn('Docker event stream error'));
    stream.on('end', () => {
      logger.warn('Docker event stream ended; reconnecting in 5s');
      setTimeout(watchDockerEvents, 5000);
    });
  });
}

function handleDockerEvent(event) {
  const uuid = event.Actor && event.Actor.Attributes && event.Actor.Attributes['pylox.server.uuid'];
  if (!uuid) return;
  switch (event.status || event.Action) {
    case 'start':
    case 'restart': {
      eventsAttach(uuid);
      state.events.emit('containerStarted', { uuid });
      // A start event from Docker's restart policy (crash loop) or a manual
      // `docker start` must not immediately advertise the server as running.
      // If the egg has a startup-done line, go to STARTING and let the
      // watcher decide; without a pattern, still require a brief settle so a
      // container that dies right after start never shows a green flash.
      if (state.isStarting(uuid)) break;
      const info = state.getServer(uuid);
      state.setStatus(uuid, state.STATUS.STARTING);
      state.beginStartupWatch(uuid, info ? info.startupDonePattern : null, config.startupTimeoutMs);
      break;
    }
    case 'die':
      state.events.emit('containerStopped', { uuid });
      state.setStatus(uuid, state.STATUS.OFFLINE);
      // The crash handler decides whether this exit was intentional and
      // whether a restart is allowed. Docker's own restart policy is off.
      state.events.emit('containerCrashed', { uuid, event });
      break;
    case 'stop':
    case 'kill':
      state.events.emit('containerStopped', { uuid });
      state.setStatus(uuid, state.STATUS.OFFLINE);
      break;
    case 'destroy':
      state.containers.delete(uuid);
      state.setStatus(uuid, state.STATUS.NOT_CREATED);
      break;
    default:
      break;
  }
}

// Compile an egg's startup-done string into a RegExp. Pterodactyl eggs use
// plain strings or "/pattern/flags" syntax; plain strings are matched as
// case-insensitive substrings of the console output.
function compileStartupPattern(done) {
  if (!done || typeof done !== 'string' || !done.trim()) return null;
  const trimmed = done.trim();
  try {
    if (trimmed.startsWith('/')) {
      const lastSlash = trimmed.lastIndexOf('/');
      if (lastSlash > 0) {
        return new RegExp(trimmed.slice(1, lastSlash), trimmed.slice(lastSlash + 1) || 'i');
      }
    }
    return new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch (_) {
    return null;
  }
}

module.exports = {
  docker,
  ping,
  isConnected,
  getContainer,
  ensureNetwork,
  ensureImage,
  ensureContainer,
  createContainer,
  refreshStatus,
  applyInspectStatus,
  disableRestartPolicy,
  discoverServers,
  watchDockerEvents,
  onDiscoverRunning,
  compileStartupPattern,
};
