export const ICON_SIZES: number[]
export function buildIco(frames: { size: number; png: Buffer }[]): Buffer
export function generateIcon(options?: { source?: string; outputDir?: string }): Promise<{ source: string; ico: string; png: string; sizes: number[] }>
