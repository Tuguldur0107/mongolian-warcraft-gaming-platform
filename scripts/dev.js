const { spawn } = require('child_process');
const path = require('path');

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function prefixOutput(stream, prefix) {
  let buffer = '';

  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line) {
        console.log(`[${prefix}] ${line}`);
      }
    }
  });

  stream.on('end', () => {
    if (buffer) {
      console.log(`[${prefix}] ${buffer}`);
    }
  });
}

function startProcess(name, args, env) {
  const child = spawn(npmCmd, args, {
    cwd: path.resolve(__dirname, '..'),
    env,
    shell: false,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  prefixOutput(child.stdout, name);
  prefixOutput(child.stderr, name);
  child.on('error', (error) => console.error(`[${name}] ${error.message}`));
  return child;
}

const children = [];
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;

  for (const child of children) {
    if (!child.killed) child.kill();
  }

  setTimeout(() => process.exit(code), 300);
}

const server = startProcess('server', ['--prefix', 'server', 'run', 'dev'], { ...process.env });
children.push(server);

server.on('exit', (code) => {
  if (!stopping) stopAll(code || 1);
});

setTimeout(() => {
  const client = startProcess(
    'client',
    ['--prefix', 'client', 'run', 'dev'],
    { ...process.env, SERVER_URL: process.env.SERVER_URL || 'http://127.0.0.1:3000' }
  );
  children.push(client);

  client.on('exit', (code) => {
    if (!stopping) stopAll(code || 1);
  });
}, 2500);

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
