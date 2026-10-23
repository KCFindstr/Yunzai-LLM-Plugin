import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // SQLite is prefix-only in Node; rewriting node:sqlite to sqlite requests an npm package.
  removeNodeProtocol: false,
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  splitting: false,
  external: ['yaml', 'image-size', 'puppeteer', 'node:sqlite'],
})
