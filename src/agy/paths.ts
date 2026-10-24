import path from 'node:path'
import os from 'node:os'
import { DATA_DIR } from '../core/paths.ts'
import { IMAGE_STORE_ROOT } from '../chat/images.ts'

export function agyHostPaths() {
  return [path.resolve(IMAGE_STORE_ROOT), path.join(os.userInfo().homedir, '.gemini', 'antigravity-cli', 'brain')]
}

/** Ordinary host task files, retained per chat session; no VM mounts or access policy. */
export function agyWorkspace(workspaceId: string) {
  if (!/^[a-f0-9]{10}$/.test(workspaceId)) throw Error('无效的 AGY 工作区编号')
  return path.resolve(DATA_DIR, 'agy-workspaces', workspaceId)
}

export function agyPathInstructions(workspaceId: string) {
  return `Path mapping (bot aliases are not real host paths): /work/attachments/<rest> = ${JSON.stringify(path.resolve(IMAGE_STORE_ROOT))} + <rest>; /work/agy/${workspaceId}/out/<rest> = ${JSON.stringify(path.join(agyWorkspace(workspaceId), 'out'))} + <rest>; CLI-generated brain/<rest> = ${JSON.stringify(agyHostPaths()[1])} + <rest>. Resolve aliases to host paths when reading files/images. Keep intermediates in the working folder; ALWAYS save final deliverables in its out directory, and report them using /work/agy/${workspaceId}/out/<rest> aliases, never the real host path. If generate_image saves to brain/, use native host commands to COPY the generated file into out/ before reporting success. Verify the destination file exists; a suggested path or a file containing instructions to copy is not a delivered image. The image store and CLI brain directory are native --add-dir workspaces; no VM or command proxy is needed.`
}

/** Resolve only a file alias explicitly supplied to a bot tool; never rewrite task/report text. */
export function agyOutputFile(alias: string, workspaceId: string) {
  const prefix = `/work/agy/${workspaceId}/out/`
  if (!alias.startsWith(prefix)) throw Error('只能读取当前 AGY 会话的输出文件')
  const root = path.join(agyWorkspace(workspaceId), 'out')
  const file = path.resolve(root, alias.slice(prefix.length))
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('无效的 AGY 输出路径')
  return file
}
