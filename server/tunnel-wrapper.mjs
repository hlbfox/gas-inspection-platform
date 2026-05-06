#!/usr/bin/env node
/**
 * Tunnel wrapper — runs a persistent SSH tunnel via serveo.net
 * URL is stable (based on SSH key fingerprint + IP)
 */
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URL_FILE = join(__dirname, 'tunnel-url.json');
const SSH_KEY = join(process.env.HOME, '.ssh/serveo_key');

const log = (msg) => console.log(`[tunnel] ${new Date().toISOString()} ${msg}`);

const child = spawn('ssh', [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'ServerAliveInterval=60',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ExitOnForwardFailure=yes',
  '-i', SSH_KEY,
  '-R', 'gasmsapi:80:localhost:3001',
  'serveo.net'
], { stdio: ['ignore', 'pipe', 'pipe'] });

child.stdout.on('data', (data) => {
  const text = data.toString();
  const match = text.match(/https:\/\/[a-z0-9]+-45-135-228-212\.serveousercontent\.com/);
  if (match) {
    const url = match[0];
    log(`🌐 Tunnel URL: ${url}`);
    writeFileSync(URL_FILE, JSON.stringify({ url, service: 'serveo', captured_at: new Date().toISOString() }));
  }
  process.stdout.write(`[out] ${text}`);
});

child.stderr.on('data', (data) => {
  const text = data.toString();
  const match = text.match(/https:\/\/[a-z0-9]+-45-135-228-212\.serveousercontent\.com/);
  if (match) {
    const url = match[0];
    log(`🌐 Tunnel URL: ${url}`);
    writeFileSync(URL_FILE, JSON.stringify({ url, service: 'serveo', captured_at: new Date().toISOString() }));
  }
  process.stderr.write(`[err] ${text}`);
});

child.on('exit', (code) => {
  log(`Tunnel exited (code: ${code})`);
  process.exit(code || 0);
});

process.on('SIGINT', () => { child.kill(); process.exit(0); });
process.on('SIGTERM', () => { child.kill(); process.exit(0); });

log('🚇 Tunnel starting via serveo...');
