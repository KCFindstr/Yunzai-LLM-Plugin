import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Ship a pinned local parser: the management UI never depends on a CDN. No source map: it only bloats the repo.
const vendor = new URL('../web/vendor/', import.meta.url)
mkdirSync(vendor, { recursive: true })
const marked = readFileSync(fileURLToPath(import.meta.resolve('marked')), 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n')
writeFileSync(new URL('marked.js', vendor), marked)
copyFileSync(new URL('../node_modules/marked/LICENSE', import.meta.url), new URL('marked.LICENSE', vendor))
