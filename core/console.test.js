'use strict';

// Keep config's data/log directories off the real daemon paths.
const os = require('os');
const path = require('path');
const tmp = path.join(os.tmpdir(), 'pylox-console-tests');
process.env.DATA_DIR = tmp;
process.env.LOG_DIR = tmp;

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('events');

const state = require('./state');

const order = [];
const broadcasts = [];
const written = [];
let logOpts = null;
const originalBroadcast = state.broadcastConsole;
const originalFeed = state.feedStartupWatch;

state.broadcastConsole = (_uuid, text) => broadcasts.push(text);
state.feedStartupWatch = () => false;

const stream = new EventEmitter();
stream.write = (data) => written.push(data);
stream.destroy = () => {};

const startedAt = '2026-01-02T03:04:05.000Z';
const container = {
  start: async () => { order.push('start'); },
  inspect: async () => ({ State: { Running: true, StartedAt: startedAt } }),
  attach: (_opts, cb) => { order.push('attach'); cb(null, stream); },
  logs: (opts, cb) => {
    order.push('logs');
    logOpts = opts;
    cb(null, Buffer.from('HISTORY\n'));
  },
};

// console.js resolves ./docker lazily; inject a fake so no real Docker client
// is constructed when the module is loaded.
const dockerPath = require.resolve('./docker');
require.cache[dockerPath] = {
  id: dockerPath,
  filename: dockerPath,
  loaded: true,
  exports: { getContainer: () => container },
};

const consoleMod = require('./console');

test('log backfill happens before the live attach and is limited to this run', async () => {
  order.length = 0;
  broadcasts.length = 0;
  try {
    await consoleMod.startContainerWithConsole('console-test', container);
    assert.deepEqual(order, ['start', 'logs', 'attach']);
    assert.deepEqual(broadcasts, ['HISTORY\n']);
    assert.equal(logOpts.since, Math.floor(new Date(startedAt).getTime() / 1000) - 1);
  } catch (err) {
    state.broadcastConsole = originalBroadcast;
    state.feedStartupWatch = originalFeed;
    throw err;
  }
});

test('echoed control commands are not broadcast back to the console', async () => {
  broadcasts.length = 0;
  written.length = 0;
  try {
    assert.equal(consoleMod.writeToConsole('console-test', '^C', { suppressEcho: true }), true);
    assert.deepEqual(written, ['^C\n']);

    stream.emit('data', Buffer.from('^C\n'));
    assert.deepEqual(broadcasts, [], 'the terminal echo should be dropped');

    stream.emit('data', Buffer.from('LIVE\n'));
    assert.deepEqual(broadcasts, ['LIVE\n']);
  } finally {
    state.broadcastConsole = originalBroadcast;
    state.feedStartupWatch = originalFeed;
  }
});

test('concurrent attach requests share one stream instead of duplicating output', async () => {
  order.length = 0;
  try {
    const [first, second] = await Promise.all([
      consoleMod.attachConsole('dedupe-test'),
      consoleMod.attachConsole('dedupe-test'),
    ]);
    assert.equal(first, second, 'both callers should receive the same stream');
    assert.equal(order.filter((entry) => entry === 'attach').length, 1);
  } finally {
    consoleMod.detachConsole('dedupe-test');
  }
});
