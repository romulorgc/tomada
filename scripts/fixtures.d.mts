export const ROOT: string
export const FIXTURES_DIR: string
export const FIXTURES_VERSION: number
export function fixturesUpToDate(): boolean
export function ensureFixtures(opts?: { force?: boolean; quiet?: boolean }): Promise<void>
export function copyTree(from: string, to: string): void
