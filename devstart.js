'use strict';

const cp = require('child_process');
const path = require('path');

process.env.TURF_WORKDIR = path.join(__dirname, '.turf');
process.env.EAGLEEYE_STATLOG_FORCE_STOP = 'true';

const httpd = cp.spawn(path.join(__dirname, 'mock/httpd'), { stdio: 'pipe', detached: false });
listen('httpd     ', httpd);

const control = cp.spawn(path.join(__dirname, 'bin/control_panel'), { stdio: 'pipe', detached: false });
listen('control   ', control);

const data = cp.spawn(path.join(__dirname, 'bin/data_panel'), { stdio: 'pipe', detached: false });
listen('data      ', data);

const turfd = cp.spawn(path.join(__dirname, 'bin/turf'), [ '-D', '-f' ], { stdio: 'ignore', detached: false });
listen('turfd     ', turfd);

process.on('SIGINT', () => {
  httpd.kill();
  control.kill();
  data.kill();
});

process.on('SIGTERM', () => {
  httpd.kill();
  control.kill();
  data.kill();
});

function listen(name, cp) {
  cp.on('exit', (code, signal) => {
    console.log(`${name} exited, code: ${code}, signal: ${signal}`);

    httpd.kill();
    control.kill();
    data.kill();
    if (name === 'control   ') turfd.kill('SIGKILL');
  });

  if (name === 'turfd     ') return;
  const stds = [ 'stdout', 'stderr' ];
  const rest = { stdout: '', stderr: '' };

  for (const std of stds) {
    cp[std].on('data', chunk => {
      if (!chunk.length) return;

      const chunkStr = chunk.toString();
      const lines = chunkStr.split('\n');
      lines[0] = rest[std] + lines[0];
      rest[std] = lines.pop();

      for (const line of lines) {
        console.log(`[${name}] ${line}`);
      }
    });
  }
}
