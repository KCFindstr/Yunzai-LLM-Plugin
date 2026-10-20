import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  shims: true,
  external: [
    '../../../lib/plugins/plugin.js',
    '../../lib/plugins/plugin.js',
    'yaml',
    'node-fetch',
    'ws'
  ]
})
