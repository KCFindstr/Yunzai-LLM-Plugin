import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Ship a pinned local parser: the management UI never depends on a CDN.
const vendor = new URL('../web/vendor/', import.meta.url)
mkdirSync(vendor, { recursive: true })
copyFileSync(fileURLToPath(import.meta.resolve('marked')), new URL('marked.js', vendor))
copyFileSync(new URL('../node_modules/marked/lib/marked.esm.js.map', import.meta.url), new URL('marked.esm.js.map', vendor))
copyFileSync(new URL('../node_modules/marked/LICENSE', import.meta.url), new URL('marked.LICENSE', vendor))
