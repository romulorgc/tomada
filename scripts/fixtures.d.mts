export const ROOT: string
export const FIXTURES_DIR: string
export const FIXTURES_VERSION: number
export function fixturesUpToDate(): boolean
export function ensureFixtures(opts?: { force?: boolean; quiet?: boolean }): Promise<void>
export function copyTree(from: string, to: string): void
export type ItemDeVoz = { id: string; kind: 'speech' | 'filler' | 'pause'; text?: string; fala?: string; ms?: number; filler?: string }
export function synthVoice(
  tmp: string,
  script?: readonly ItemDeVoz[],
  opts?: { leadMs?: number; tailMs?: number; joinMs?: number }
): Promise<{ wav: string; gabarito: { durationMs: number; segments: { id: string; kind: string; text?: string; startMs: number; endMs: number }[]; [k: string]: unknown } }>
