/**
 * tunnel.js - self-healing pinggy tunnel manager for Free App Enricher.
 *
 * Why this exists: free pinggy tunnels expire after 60 minutes and every
 * restart produces a NEW random URL. This script:
 *   1. Opens the pinggy tunnel via Windows' built-in SSH client.
 *   2. Detects the public URL in the SSH output.
 *   3. Publishes the URL to a private ntfy.sh channel (topic) so the Google
 *      Sheet script can auto-update itself - no manual URL pasting.
 *   4. Restarts the tunnel every RESTART_MINUTES (before the 60 min expiry)
 *      and whenever the SSH connection drops, then re-publishes the new URL.
 *
 * The channel code is stored in ntfy-topic.txt so it stays the same across
 * restarts. Paste that code once in the sheet (menu 2) and you are done.
 */
'use strict';

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';

const DIR = import.meta.dirname;
const TOPIC_FILE = path.join(DIR, 'ntfy-topic.txt');
const URL_FILE = path.join(DIR, 'tunnel-url.txt');
const LOCAL_PORT = 3000;
const RESTART_MINUTES = 50; // proactive restart before pinggy's 60 min free limit
const RETRY_DELAY_MS = 5000;

function loadOrCreateTopic() {
  try {
    const existing = fs.readFileSync(TOPIC_FILE, 'utf8').trim();
    if (/^[a-zA-Z0-9_-]{8,64}$/.test(existing)) return existing;
  } catch (err) { /* first run - create below */ }
  const created = 'app-enricher-' + crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(TOPIC_FILE, created);
  return created;
}

const TOPIC = loadOrCreateTopic();

function publishUrl(url) {
  return new Promise(resolve => {
    const req = https.request({
      method: 'POST',
      host: 'ntfy.sh',
      path: '/' + TOPIC,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Title': 'enricher-url' },
      timeout: 15000
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end(url);
  });
}

const stripAnsi = text => String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
// Match the ALLOCATED tunnel URL only (e.g. https://rejoj-1-2-3-4.free.pinggy.net).
// The pinggy banner also prints https://dashboard.pinggy.io - never match that.
const URL_RE = /https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\.pinggy\.net/i;

let child = null;
let restartTimer = null;
let buffer = '';
let announced = false;

function onTunnelUrl(url) {
  if (announced) return;
  announced = true;
  try { fs.writeFileSync(URL_FILE, url); } catch (err) { /* non-fatal */ }
  console.log('');
  console.log('============================================================');
  console.log('  YOUR ENRICHER URL:  ' + url);
  console.log('  AUTO-UPDATE CODE:   ' + TOPIC);
  console.log('  The sheet updates itself from this code (menu 2).');
  console.log('============================================================');
  console.log('');
  publishUrl(url).then(ok => {
    console.log(ok
      ? '[' + new Date().toISOString() + '] URL published to auto-update channel.'
      : '[' + new Date().toISOString() + '] WARNING: could not publish URL to channel (check internet). URL still works if pasted manually.');
  });
}

function startTunnel() {
  announced = false;
  buffer = '';
  console.log('[' + new Date().toISOString() + '] Opening tunnel to local server on port ' + LOCAL_PORT + ' ...');

  child = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-p', '443',
    '-R0:localhost:' + LOCAL_PORT,
    'a.pinggy.io'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const onData = chunk => {
    const text = stripAnsi(chunk);
    process.stdout.write(text);
    buffer += text;
    if (!announced) {
      const match = buffer.match(URL_RE);
      if (match) onTunnelUrl(match[0]);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  // Proactive refresh before the free-tier 60 minute cutoff.
  restartTimer = setTimeout(() => {
    console.log('[' + new Date().toISOString() + '] Scheduled tunnel refresh (avoiding the 60-minute expiry)...');
    if (child) child.kill();
  }, RESTART_MINUTES * 60 * 1000);

  child.on('close', code => {
    clearTimeout(restartTimer);
    console.log('[' + new Date().toISOString() + '] Tunnel closed (code ' + code + '). Reconnecting in ' + (RETRY_DELAY_MS / 1000) + 's...');
    setTimeout(startTunnel, RETRY_DELAY_MS);
  });
  child.on('error', err => {
    clearTimeout(restartTimer);
    console.log('[' + new Date().toISOString() + '] Could not start ssh: ' + err.message + '. Retrying in ' + (RETRY_DELAY_MS / 1000) + 's...');
    setTimeout(startTunnel, RETRY_DELAY_MS);
  });
}

console.log('============================================================');
console.log('  Free App Enricher - self-healing tunnel (pinggy + ntfy)');
console.log('  Channel code: ' + TOPIC);
console.log('  Keep this window open. It renews the URL automatically.');
console.log('============================================================');
startTunnel();
