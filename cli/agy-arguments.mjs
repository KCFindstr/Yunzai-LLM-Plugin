/** Validate before crossing into WSL. Some CLI model calls use cmd despite the advertised command schema. */
export function agyOperation(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'Tool arguments must be an object.' }
  if (name === 'exec') {
    const command = Object.hasOwn(args, 'command') ? args.command : args.cmd
    if (typeof command !== 'string' || !command.trim()) return { error: 'exec requires a non-empty "command" string; example: {"command":"ls -la /work"}. The alias "cmd" is also accepted.' }
    if (command.length > 24000) return { error: 'exec command exceeds the 24000-character limit.' }
    return { op: 'exec', command }
  }
  if (name === 'read_image') {
    if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 300 || args.path.includes('\0')) return { error: 'read_image requires a valid "path" string under /work.' }
    return { op: 'image', path: args.path }
  }
  return { error: 'Unknown tool.' }
}
