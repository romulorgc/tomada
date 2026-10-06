export interface LaunchConfig {
  executable: string
  args: string[]
  workingDir: string
  requiredFiles?: string[]
  wait?: boolean
  windowStyle?: 0 | 1
}
export interface ShortcutInfo { path: string; target: string; arguments: string; workingDir: string; icon: string; windowStyle: number }
export interface ShortcutInstall { appDir: string; executable: string; appArguments: string[]; launcher: string; icon: string; manifest: string; backups: string[]; shortcuts: ShortcutInfo[] }
export function createLaunchConfig(appDir: string): LaunchConfig
export function quoteWindowsArg(value: string): string
export function buildLaunchScript(config: LaunchConfig): string
export function encodeVbs(script: string): Buffer
export function inspectShortcuts(shortcuts: string[]): Promise<ShortcutInfo[]>
export function installShortcuts(options?: { appDir?: string; launchDir?: string; icon?: string }): Promise<ShortcutInstall>
