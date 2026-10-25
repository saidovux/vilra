import {copyFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';

import {build} from 'esbuild';

import {repoRoot} from './electron-build-context.mjs';

const distDirectory = join(repoRoot, 'static', 'dist');
mkdirSync(distDirectory, {recursive: true});

await build({
  entryPoints: [join(repoRoot, 'static', 'src', 'main.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  outfile: join(distDirectory, 'app.js'),
});

copyFileSync(
  join(repoRoot, 'static', 'src', 'styles.css'),
  join(repoRoot, 'static', 'app.css'),
);
