'use strict';

const WebSocket = require('ws');
const config = require('../config');
const logger = require('../logger');
const state = require('../core/state');
const docker = require('../core/docker');
const consoleMod = require('../core/console');
const power = require('../core/power');
const { safeEqual, demux, brandConsole, computeCpuPercent, logSince } = require('../utils');

// Attach the console WebSocket server to an http.Server on path /ws.
function attachWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  // Heartbeat so dead connections are reaped promptly.
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('connection', async (ws, req) => {
    let params;
    try {
      params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    } catch (_) {
      ws.close();
      return;
    }

    const token = params.get('token');
    const uuid = params.get('server');
    const replay = params.get('replay') !== '0';

    if (!safeEqual(token, config.token)) {
      ws.send(JSON.stringify({ event: 'error', message: 'Unauthorized' }));
      return ws.close();
    }
    if (!uuid) {
      ws.send(JSON.stringify({ event: 'error', message: 'Server UUID required' }));
      return ws.close();
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    logger.info(`Console connected: ${uuid}`);

    // Register only after the log tail has been sent. While this socket is in
    // the broadcast set, live output and the history replay would overlap and
    // show the same startup lines twice.
    let registered = false;
    const registerClient = () => {
      if (registered) return;
      registered = true;
      state.addClient(uuid, ws);
    };

    try {
      const inspect = await docker.getContainer(uuid).inspect();
      if (replay && inspect.State.Running) {
        const history = await consoleMod.readTail(uuid, 100, logSince(inspect));
        if (history && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'console', data: brandConsole(history) }));
        }
      }
      registerClient();
      if (inspect.State.Running) await consoleMod.attachConsole(uuid);
      if (replay) {
        const sys = state.getSystemHistory(uuid);
        if (sys.length && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'console', data: sys.join('') }));
        }
      }
      const status = inspect.State.Running ? (state.getStatus(uuid) || state.STATUS.RUNNING) : state.STATUS.OFFLINE;
      ws.send(JSON.stringify({ event: 'status', status }));
    } catch (_) {
      registerClient();
      if (replay) {
        const sys = state.getSystemHistory(uuid);
        if (sys.length && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'console', data: sys.join('') }));
        }
      }
      ws.send(JSON.stringify({ event: 'status', status: state.STATUS.NOT_CREATED }));
    }

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      try {
        switch (msg.action) {
          case 'start':
            await power.start(uuid);
            break;
          case 'stop':
            await power.stop(uuid);
            break;
          case 'restart':
            await power.restart(uuid);
            break;
          case 'kill':
            await power.kill(uuid);
            break;
          case 'command': {
            if (!consoleMod.writeToConsole(uuid, msg.command)) {
              const container = docker.getContainer(uuid);
              const exec = await container.exec({
                Cmd: ['/bin/sh', '-c', msg.command],
                AttachStdout: true,
                AttachStderr: true,
              });
              const stream = await exec.start({ Detach: false, Tty: true });
              stream.on('data', (chunk) => state.broadcastConsole(uuid, demux(chunk)));
            }
            break;
          }
          case 'status': {
            const status = state.getStatus(uuid);
            ws.send(JSON.stringify({ event: 'status', status }));
            break;
          }
          case 'stats': {
            try {
              const stats = await docker.getContainer(uuid).stats({ stream: false });
              ws.send(JSON.stringify({
                event: 'stats',
                cpu: Math.round(computeCpuPercent(stats) * 100) / 100,
                memory: stats.memory_stats ? (stats.memory_stats.usage || 0) : 0,
                memory_limit: stats.memory_stats ? (stats.memory_stats.limit || 0) : 0,
              }));
            } catch (_) { /* ignore */ }
            break;
          }
          default:
            break;
        }
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'error', message: err.message }));
        }
      }
    });

    ws.on('close', () => {
      state.removeClient(uuid, ws);
      logger.info(`Console disconnected: ${uuid}`);
    });
  });

  return wss;
}

module.exports = { attachWebSocket };
