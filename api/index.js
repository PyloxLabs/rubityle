'use strict';

const os = require('os');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('../config');
const logger = require('../logger');
const state = require('../core/state');
const docker = require('../core/docker');
const consoleMod = require('../core/console');
const power = require('../core/power');
const limits = require('../core/limits');
const utils = require('../utils');
const { runInstall } = require('./install');
const { registerFileRoutes } = require('./files');
const { registerBackupRoutes } = require('./backups');
const { storeSftpPassword } = require('../sftp/store');

function authMiddleware(req, res, next) {
  if (!utils.safeEqual(req.headers['x-daemon-token'], config.token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Build the express app. The WebSocket upgrade handler is attached separately
// by websocket.js against the same http.Server.
function createApp() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.use(morgan('tiny', { stream: { write: (msg) => logger.info(msg.trim()) } }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', daemon: 'rubityle', version: '3.0.0', uptime: process.uptime() });
  });

  app.get('/api/info', authMiddleware, (req, res) => {
    const disk = utils.getDiskInfo();
    res.json({
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      total_memory: os.totalmem(),
      free_memory: os.freemem(),
      total_disk: disk.total_disk,
      free_disk: disk.free_disk,
      uptime: os.uptime(),
      node_version: process.version,
      docker_connected: docker.isConnected(),
      managed_servers: state.servers.size,
      network: config.network,
      sftp_port: config.sftpPort,
    });
  });

  // Server collection. The status cache is refreshed from a live inspect so a
  // stale cache can never make an offline server look running (B5).
  app.get('/api/servers', authMiddleware, async (req, res) => {
    const list = [];
    for (const [uuid, info] of state.servers) {
      let status = info.status || state.STATUS.OFFLINE;
      try {
        const inspect = await docker.getContainer(uuid).inspect();
        if (inspect.State.Running) {
          // Respect an in-progress startup watch; otherwise report running.
          status = state.getStatus(uuid) === state.STATUS.STARTING ? state.STATUS.STARTING : state.STATUS.RUNNING;
          info.startedAt = utils.sanitizeStartedAt(inspect.State.StartedAt);
        } else {
          status = state.STATUS.OFFLINE;
        }
      } catch (_) { /* keep cached */ }
      state.setStatus(uuid, status);
      list.push({ ...info, status });
    }
    res.json({ servers: list });
  });

  // Create/ensure a server container. Accepts stopCommand + startupDone so the
  // daemon can use the egg's graceful-stop and startup-done lines.
  app.post('/api/servers', authMiddleware, async (req, res) => {
    const { uuid, name, image, env, memory, cpu, swap, io, disk, ports, startup, stopCommand, startupDone, sftpPassword } = req.body || {};
    if (!uuid || !image) {
      return res.status(400).json({ error: 'uuid and image are required' });
    }

    if (typeof sftpPassword === 'string' && sftpPassword) {
      storeSftpPassword(uuid, sftpPassword);
    }

    const cfg = {
      uuid,
      name: name || uuid,
      image,
      env: env || [],
      memory: memory || 0,
      cpu: cpu || 0,
      swap: swap || 0,
      io: io || 0,
      disk: disk || 0,
      ports: ports || [],
      startup: startup || '',
      stopCommand: typeof stopCommand === 'string' ? stopCommand : '',
      startupDone: typeof startupDone === 'string' ? startupDone : '',
    };

    try {
      const result = await docker.ensureContainer(cfg);
      limits.mergePersistedLimits(uuid, state.getServer(uuid) || cfg);
      logger.info(`Server ${result.created ? 'created' : 'present'}: ${uuid}`);
      res.json({
        status: result.created ? 'created' : 'exists',
        uuid,
        containerId: result.container.id,
        running: result.running,
        deferred: !!result.pendingRecreate,
      });
    } catch (err) {
      logger.error(`Failed to create server ${uuid}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  const serversRouter = express.Router();
  app.use('/api/servers', authMiddleware, serversRouter);

  // Power actions. The daemon is the single source of truth for status, so the
  // response always carries the post-action status for the panel to persist.
  serversRouter.post('/:uuid/start', async (req, res) => {
    const { uuid } = req.params;
    try {
      const result = await power.start(uuid);
      logger.info(`Server started: ${uuid}`);
      res.json({ status: result.status });
    } catch (err) {
      if (err.code === 'disk_limit_blocked') {
        return res.status(409).json({ error: err.message, code: err.code, used_mb: err.used_mb, limit_mb: err.limit_mb });
      }
      if (err.statusCode === 404) {
        return res.status(404).json({ error: err.message, code: err.code });
      }
      logger.error(`Failed to start server ${uuid}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  serversRouter.post('/:uuid/stop', async (req, res) => {
    const { uuid } = req.params;
    try {
      const result = await power.stop(uuid);
      logger.info(`Server stopped: ${uuid}`);
      res.json({ status: result.status });
    } catch (err) {
      logger.error(`Failed to stop server ${uuid}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  serversRouter.post('/:uuid/kill', async (req, res) => {
    const { uuid } = req.params;
    try {
      const result = await power.kill(uuid);
      logger.info(`Server killed: ${uuid}`);
      res.json({ status: result.status });
    } catch (err) {
      logger.error(`Failed to kill server ${uuid}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  serversRouter.post('/:uuid/restart', async (req, res) => {
    const { uuid } = req.params;
    try {
      const result = await power.restart(uuid);
      logger.info(`Server restarted: ${uuid}`);
      res.json({ status: result.status });
    } catch (err) {
      if (err.code === 'disk_limit_blocked') {
        return res.status(409).json({ error: err.message, code: err.code, used_mb: err.used_mb, limit_mb: err.limit_mb });
      }
      logger.error(`Failed to restart server ${uuid}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  serversRouter.post('/:uuid/sftp/password', (req, res) => {
    const { uuid } = req.params;
    const { password } = req.body || {};
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'password is required' });
    }
    storeSftpPassword(uuid, password);
    logger.info(`SFTP password updated for ${uuid}`);
    res.json({ ok: true });
  });

  serversRouter.delete('/:uuid', async (req, res) => {
    const { uuid } = req.params;
    try {
      await power.destroy(uuid);
      logger.info(`Server deleted: ${uuid}`);
      res.json({ status: 'deleted' });
    } catch (err) {
      logger.error(`Failed to delete server ${uuid}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  serversRouter.get('/:uuid/status', async (req, res) => {
    const { uuid } = req.params;
    try {
      const inspect = await docker.getContainer(uuid).inspect();
      const status = inspect.State.Running ? state.getStatus(uuid) : state.STATUS.OFFLINE;
      if (!inspect.State.Running || status !== state.STATUS.STARTING) {
        state.setStatus(uuid, status);
      }
      if (inspect.State.Running && inspect.State.StartedAt) {
        const info = state.getServer(uuid);
        if (info) info.startedAt = utils.sanitizeStartedAt(inspect.State.StartedAt);
      }
      res.json({
        status: inspect.State.Running ? (state.getStatus(uuid) || state.STATUS.RUNNING) : state.STATUS.OFFLINE,
        state: inspect.State.Status,
        running: !!inspect.State.Running,
        startedAt: utils.sanitizeStartedAt(inspect.State.StartedAt),
        finishedAt: inspect.State.FinishedAt,
        exitCode: inspect.State.ExitCode,
        pid: inspect.State.Pid,
        containerId: inspect.Id,
      });
    } catch (_) {
      state.setStatus(uuid, state.STATUS.NOT_CREATED);
      res.json({ status: state.STATUS.NOT_CREATED, state: state.STATUS.NOT_CREATED, running: false });
    }
  });

  serversRouter.get('/:uuid/stats', async (req, res) => {
    const { uuid } = req.params;
    if (req.query.memory !== undefined || req.query.cpu !== undefined || req.query.disk !== undefined) {
      limits.applyServerLimits(uuid, { memory: req.query.memory, cpu: req.query.cpu, disk: req.query.disk });
    }
    const disk = utils.getServerDiskUsage(uuid);
    let containerId = null;
    try {
      // Inspect FIRST: stats can succeed even when the container is not running
      // (Docker 304 / dockerode quirk), which used to make offline or
      // never-started containers report "running" with the year-1 sentinel
      // StartedAt timestamp (~740 000 days of fake uptime).
      const inspect = await docker.getContainer(uuid).inspect();
      containerId = inspect.Id;
      if (!inspect.State.Running) {
        const status = inspect.State.Restarting ? state.STATUS.STARTING : state.STATUS.OFFLINE;
        state.setStatus(uuid, status);
        return res.json({ status, containerId, cpu: 0, memory: 0, memory_limit: 0, memory_percent: 0, disk, startedAt: null, uptime: 0, network_rx: 0, network_tx: 0, disk_read: 0, disk_write: 0 });
      }
      // During startup, skip the expensive stats() call — Minecraft boot can
      // take >1.5s under load, causing the panel's circuit breaker to trip
      // and show a false "Reconnecting to node" modal.
      if (state.getStatus(uuid) === state.STATUS.STARTING) {
        const info = state.getServer(uuid) || {};
        info.startedAt = utils.sanitizeStartedAt(inspect.State.StartedAt);
        return res.json({ status: state.STATUS.STARTING, containerId, cpu: 0, memory: 0, memory_limit: 0, memory_percent: 0, disk, startedAt: info.startedAt, uptime: info.startedAt ? Math.max(0, Math.floor((Date.now() - new Date(info.startedAt).getTime()) / 1000)) : 0, network_rx: 0, network_tx: 0, disk_read: 0, disk_write: 0 });
      }
      const stats = await docker.getContainer(uuid).stats({ stream: false });
      const info = state.getServer(uuid) || {};
      // Keep a server that is still starting in the "starting" state rather than
      // prematurely reporting it as running (B2/B5).
      if (state.getStatus(uuid) !== state.STATUS.STARTING) {
        state.setStatus(uuid, state.STATUS.RUNNING);
      }
      info.startedAt = utils.sanitizeStartedAt(inspect.State.StartedAt);

      const cpuPercent = utils.computeCpuPercent(stats);
      const memoryUsage = stats.memory_stats ? (stats.memory_stats.usage || 0) : 0;
      const memoryLimit = stats.memory_stats ? (stats.memory_stats.limit || 0) : 0;

      res.json({
        status: state.getStatus(uuid),
        containerId,
        cpu: Math.round(cpuPercent * 100) / 100,
        memory: memoryUsage,
        memory_limit: memoryLimit,
        memory_percent: memoryLimit ? Math.round((memoryUsage / memoryLimit) * 10000) / 100 : 0,
        disk,
        startedAt: info.startedAt || null,
        uptime: info.startedAt ? Math.max(0, Math.floor((Date.now() - new Date(info.startedAt).getTime()) / 1000)) : 0,
        network_rx: stats.networks ? Object.values(stats.networks).reduce((a, n) => a + (n.rx_bytes || 0), 0) : 0,
        network_tx: stats.networks ? Object.values(stats.networks).reduce((a, n) => a + (n.tx_bytes || 0), 0) : 0,
        disk_read: stats.blkio_stats?.io_service_bytes_recursive?.find((x) => x.op === 'Read')?.value || 0,
        disk_write: stats.blkio_stats?.io_service_bytes_recursive?.find((x) => x.op === 'Write')?.value || 0,
      });
    } catch (err) {
      // Stats failed: report the container's true state rather than a stale one.
      let status = state.STATUS.OFFLINE;
      try {
        containerId = (await docker.getContainer(uuid).inspect()).Id;
      } catch (_) {
        status = state.STATUS.NOT_CREATED;
      }
      state.setStatus(uuid, status);
      res.json({ status, containerId, cpu: 0, memory: 0, memory_limit: 0, memory_percent: 0, disk, network_rx: 0, network_tx: 0, disk_read: 0, disk_write: 0 });
    }
  });

  serversRouter.post('/:uuid/limits', (req, res) => {
    const { uuid } = req.params;
    const { memory, cpu, disk } = req.body || {};
    limits.applyServerLimits(uuid, { memory, cpu, disk });
    const info = state.getServer(uuid) || {};
    res.json({ status: 'ok', memory: info.memory || 0, cpu: info.cpu || 0, disk: info.disk || 0 });
  });

  serversRouter.post('/:uuid/exec', async (req, res) => {
    const { uuid } = req.params;
    const { command } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command required' });

    try {
      const container = docker.getContainer(uuid);
      const exec = await container.exec({
        Cmd: ['/bin/sh', '-c', command],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ Detach: false, Tty: true });

      let output = '';
      stream.on('data', (chunk) => { output += utils.demux(chunk); });
      stream.on('end', () => res.json({ output }));
      stream.on('error', (err) => res.status(500).json({ error: err.message }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  serversRouter.post('/:uuid/command', (req, res) => {
    const { uuid } = req.params;
    const { command } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command required' });
    const written = consoleMod.writeToConsole(uuid, command);
    res.json({ status: written ? 'sent' : 'not_attached' });
  });

  serversRouter.post('/:uuid/install', async (req, res) => {
    const { uuid } = req.params;
    const { install, env } = req.body || {};
    try {
      const result = await runInstall(uuid, install, env);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  registerFileRoutes(serversRouter);
  registerBackupRoutes(serversRouter);

  return app;
}

module.exports = { createApp };
