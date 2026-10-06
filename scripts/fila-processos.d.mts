export type ProcessMetadata = { ProcessId?: number; Name: string; CommandLine?: string | null }
export function isTestRunner(process: ProcessMetadata): boolean
export function hasTestRunner(processes: ProcessMetadata[]): boolean
