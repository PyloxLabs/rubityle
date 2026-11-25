'use strict';

require('dotenv').config();

const http = require('http');
const config = require('./config');
const logger = require('./logger');
const state = require('./core/state');
const docker = require('./core/docker');
const consoleMod = require('./core/console');
const limits = require('./core/limits');
const power = require('./core/power');
const crash = require('./core/crash');
const { createApp } = require('./api');
const { attachWebSocket } = require('./api/websocket');
const { startSftpServer } = require('./sftp/server');
const { loadSftpHostKey } = require('./sftp/store');

// Wire the discovery attach hook: docker.js calls this for containers it finds
// already running so their console streams are re-attached without a cycle.
docker.onDiscoverRunning((uuid) => {
  // power.start() owns the attach during an intentional boot: it backfills the
  // boot log first, then attaches. Attaching here would stream the early boot
  // lines before that backfill and show every one of them twice.
  if (state.isStarting(uuid)) return;
  consoleMod.attachConsole(uuid);
});

// Wire Docker lifecycle events into the power/state layer.
docker.watchDockerEvents();
state.events.on('containerStarted', ({ uuid }) => {
  // Nothing to do beyond what docker.js already broadcast; the attach is
  // handled by the onDiscoverRunning hook above when needed.
});
state.events.on('containerStopped', ({ uuid }) => {
  consoleMod.detachConsole(uuid);
});
state.events.on('containerCrashed', (payload) => {
  Promise.resolve(crash.handleContainerExit(payload)).catch((err) => {
    logger.error(`Crash handler failed for ${payload && payload.uuid}: ${err.message}`);
  });
});

(async () => {
  await docker.discoverServers();
  await docker.ping();
  setInterval(() => docker.ping(), 30000);
  limits.startResourceMonitor();

  const app = createApp();
  const server = http.createServer(app);
  attachWebSocket(server);

  server.listen(config.port, () => {
    logger.info(`Rubityle v3 listening on port ${config.port}`);
    logger.info(`Data directory: ${config.dataDir}`);
    logger.info(`Network: ${config.network}`);
    logger.info(`Docker socket: ${config.dockerSocket}`);
  });

  let sftpServer = null;
  const hostKey = loadSftpHostKey();
  try {
    sftpServer = startSftpServer({
      host: '0.0.0.0',
      port: config.sftpPort,
      dataDir: config.dataDir,
      hostKey: hostKey.pem,
      log: logger,
    });
  } catch (err) {
    logger.error(`Failed to start SFTP server: ${err && err.message ? err.message : err}`);
  }

  async function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down`);
    if (sftpServer) sftpServer.close();
    consoleMod.detachAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error(`Unhandled rejection: ${err && err.message ? err.message : err}`));
})();
