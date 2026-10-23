import path from 'node:path'

/** Same private profile for setup checks and actual CLI jobs; no inherited provider keys. */
export function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const win = process.env.SystemRoot || 'C:\\Windows'
  return { SystemRoot: win, WINDIR: win, COMSPEC: path.join(win, 'System32', 'cmd.exe'),
    PATH: [path.join(win, 'System32'), win, path.join(win, 'System32/WindowsPowerShell/v1.0')].join(';'),
    SHELL: path.join(win, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    TEMP: path.join(home, 'temp'), TMP: path.join(home, 'temp'), AGY_CLI_HIDE_ACCOUNT_INFO: '1' }
}
