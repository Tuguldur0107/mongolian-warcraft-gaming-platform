const { spawn } = require('child_process');

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCmd, args, {
      stdio: 'inherit',
      shell: false,
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed with exit code ${code}`));
    });

    child.on('error', reject);
  });
}

async function main() {
  console.log('Installing server dependencies...');
  await run('server install', ['install', '--prefix', 'server']);

  console.log('Installing client dependencies...');
  await run('client install', ['install', '--prefix', 'client']);

  console.log('Setup complete.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
