import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const define = { 'globalThis.__PROBE_VERSION__': JSON.stringify(pkg.version) };

export default defineConfig([
  {
    entry: { 'bin/probe': 'bin/probe.ts', 'bin/probe-mcp': 'bin/probe-mcp.ts' },
    format: ['esm'],
    target: 'node18',
    outDir: 'dist',
    clean: true,
    splitting: false,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
    define,
    external: ['better-sqlite3'],
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node18',
    outDir: 'dist',
    dts: true,
    splitting: false,
    sourcemap: true,
    define,
    external: ['better-sqlite3'],
  },
]);
