import { describe, expect, it } from 'vitest'
import {
  EXPORT_SIZES,
  avcCodecString,
  avcLevelIdc,
  defaultExportStem,
  etaMs,
  exportBitrate,
  exportFileName,
  exportFormat,
  exportRequestSchema,
  fileTimeSeconds,
  outputFrameCount,
  outputFrameTime,
  sanitizeFileName,
  sourceTimeOfFrame
} from '@shared/export'
import { keptRanges, outputDuration } from '@shared/timeline'
import { computeSyntheticCursor, createCursorLookup, sampleSynthetic } from '@shared/cursor'

describe('plano da exportação', () => {
  it('resoluções e taxas de bits do projeto', () => {
    expect(EXPORT_SIZES['1080p']).toEqual({ w: 1920, h: 1080 })
    expect(EXPORT_SIZES['1440p']).toEqual({ w: 2560, h: 1440 })
    expect(EXPORT_SIZES['2160p']).toEqual({ w: 3840, h: 2160 })
    expect(exportBitrate('1080p', 30)).toBe(8_000_000)
    expect(exportBitrate('1080p', 60)).toBe(12_000_000)
    expect(exportBitrate('1440p', 30)).toBe(16_000_000)
    expect(exportBitrate('1440p', 60)).toBe(24_000_000)
    expect(exportBitrate('2160p', 30)).toBe(40_000_000)
    expect(exportFormat({ resolution: '1440p', fps: 30 })).toEqual({ kind: 'horizontal', w: 2560, h: 1440 })
  })

  it('nível do H.264 High pelo tamanho e taxa (tabela A-1)', () => {
    expect(avcLevelIdc(1920, 1080, 30)).toBe(0x28)
    expect(avcLevelIdc(1920, 1080, 60)).toBe(0x2a)
    expect(avcLevelIdc(2560, 1440, 30)).toBe(0x32)
    expect(avcLevelIdc(2560, 1440, 60)).toBe(0x33)
    expect(avcLevelIdc(3840, 2160, 30)).toBe(0x33)
    expect(avcLevelIdc(3840, 2160, 60)).toBe(0x34)
    expect(avcCodecString(1920, 1080, 30)).toBe('avc1.640028')
    expect(avcCodecString(3840, 2160, 60)).toBe('avc1.640034')
  })

  it('quantidade de quadros = duração × taxa, arredondada (±1 quadro)', () => {
    expect(outputFrameCount(10_000, 30)).toBe(300)
    expect(outputFrameCount(10_016, 30)).toBe(300)
    expect(outputFrameCount(10_020, 30)).toBe(301)
    expect(outputFrameCount(23_000, 60)).toBe(1380)
    expect(outputFrameCount(1, 30)).toBe(1)
    expect(outputFrameCount(0, 30)).toBe(0)
    expect(outputFrameCount(-5, 30)).toBe(0)
    for (const ms of [999, 12_345, 600_000, 33_333]) {
      expect(Math.abs((outputFrameCount(ms, 30) / 30) * 1000 - ms)).toBeLessThanOrEqual(1000 / 30)
    }
    expect(outputFrameTime(30, 30)).toBe(1000)
    expect(outputFrameTime(1, 60)).toBeCloseTo(16.6667, 3)
  })

  it('sequência de tempos de origem: crescente, com saltos só nos cortes', () => {
    const cuts = [
      { start: 2000, end: 3500, enabled: true },
      { start: 6000, end: 6800, enabled: true }
    ]
    const dur = 10_000
    const kept = keptRanges(dur, cuts)
    const total = outputFrameCount(outputDuration(dur, cuts), 30)
    let prev = -1
    const jumps: number[] = []
    for (let i = 0; i < total; i++) {
      const t = sourceTimeOfFrame(i, 30, kept)
      expect(t).toBeGreaterThanOrEqual(prev) // monotônica
      expect(t).toBeLessThanOrEqual(dur)
      if (prev >= 0 && t - prev > 40) jumps.push(Math.round(t - prev))
      // nunca cai dentro de um corte
      for (const c of cuts) expect(t >= c.start && t < c.end).toBe(false)
      prev = t
    }
    expect(jumps).toHaveLength(2)
    expect(jumps[0]).toBeGreaterThan(1500)
    expect(jumps[1]).toBeGreaterThan(800)
    // o primeiro quadro é o início, o último é o fim
    expect(sourceTimeOfFrame(0, 30, kept)).toBeCloseTo(0.5, 6)
    expect(sourceTimeOfFrame(total - 1, 30, kept)).toBeLessThan(dur)
  })

  it('tempo no arquivo = tempo da gravação − deslocamento da fonte (nunca negativo)', () => {
    expect(fileTimeSeconds(5000, 0)).toBe(5)
    expect(fileTimeSeconds(5000, 200)).toBe(4.8)
    expect(fileTimeSeconds(100, 300)).toBe(0)
  })

  it('nome do arquivo: <título> - YouTube 1080p.mp4, sem caracteres proibidos no Windows', () => {
    expect(exportFileName('Aula de Psicanálise nº 2', { resolution: '1080p', fps: 30 })).toBe('Aula de Psicanálise nº 2 - YouTube 1080p.mp4')
    expect(exportFileName('x', { resolution: '1080p', fps: 60 })).toBe('x - YouTube 1080p60.mp4')
    expect(exportFileName('x', { resolution: '2160p', fps: 30 })).toBe('x - YouTube 4K.mp4')
    expect(exportFileName('x', { resolution: '1440p', fps: 30 })).toBe('x - YouTube 1440p.mp4')
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j')
    expect(sanitizeFileName('  ...  ')).toBe('Gravação')
    expect(sanitizeFileName('fim com ponto.')).toBe('fim com ponto')
    expect(sanitizeFileName('CON')).toBe('CON_')
    expect(sanitizeFileName('a'.repeat(300)).length).toBeLessThanOrEqual(120)
  })

  it('nome escolhido na exportação: sem extensão, sem caracteres proibidos, vazio cai no padrão', () => {
    const base = { resolution: '1080p', fps: 30 } as const
    expect(defaultExportStem('Aula 1', { resolution: '2160p', fps: 60 })).toBe('Aula 1 - YouTube 4K60')
    expect(exportFileName('Aula 1', { ...base, fileName: 'Minha aula final' })).toBe('Minha aula final.mp4')
    expect(exportFileName('Aula 1', { ...base, fileName: 'Minha aula final.MP4' })).toBe('Minha aula final.mp4')
    expect(exportFileName('Aula 1', { ...base, fileName: '  com espaços  ' })).toBe('com espaços.mp4')
    expect(exportFileName('Aula 1', { ...base, fileName: 'a/b:c' })).toBe('a b c.mp4')
    expect(exportFileName('Aula 1', { ...base, fileName: '   ' })).toBe('Aula 1 - YouTube 1080p.mp4')
    expect(exportFileName('Aula 1', { ...base, fileName: '.mp4' })).toBe('Aula 1 - YouTube 1080p.mp4')
    expect(exportFileName('Aula 1', base)).toBe('Aula 1 - YouTube 1080p.mp4')
  })

  it('o pedido de exportação aceita nome e pasta, e recusa o que não é do formato', () => {
    const ok = { projectId: 'p', resolution: '1440p', fps: 60 }
    expect(exportRequestSchema.parse(ok)).toEqual(ok)
    expect(exportRequestSchema.parse({ ...ok, fileName: 'x', dir: 'C:\Videos' })).toMatchObject({ fileName: 'x', dir: 'C:\Videos' })
    expect(() => exportRequestSchema.parse({ ...ok, dir: '' })).toThrow()
    expect(() => exportRequestSchema.parse({ ...ok, fileName: 'x'.repeat(201) })).toThrow()
    expect(() => exportRequestSchema.parse({ ...ok, fps: 24 })).toThrow()
    expect(() => exportRequestSchema.parse({ ...ok, resolution: '8k' })).toThrow()
  })

  it('ETA a partir dos quadros por segundo', () => {
    expect(etaMs(100, 1100, 100)).toBe(10_000)
    expect(etaMs(0, 100, 10)).toBeNull()
    expect(etaMs(10, 100, 0)).toBeNull()
  })

  it('o cursor sintético reaparece quando há atividade (clique) enquanto está parado', () => {
    const still = Array.from({ length: 700 }, (_, i) => ({ t: i * 8, x: 0.5, y: 0.5 }))
    const base = { durationMs: 5000, hideAfterIdleMs: 2000 }
    const hidden = computeSyntheticCursor(createCursorLookup(still), base)
    expect(sampleSynthetic(hidden, 4000).alpha).toBeCloseTo(0, 6)
    const shown = computeSyntheticCursor(createCursorLookup(still), { ...base, activity: [3900] })
    expect(sampleSynthetic(shown, 4000).alpha).toBeGreaterThan(0.3)
  })
})

describe('exportação vertical (M4a): 1080×1920, 10/12 Mbps, nome próprio', () => {
  it('o vertical é sempre 1080×1920, qualquer que seja a resolução pedida', () => {
    for (const resolution of ['1080p', '1440p', '2160p'] as const) {
      expect(exportFormat({ resolution, fps: 30, format: 'vertical' })).toEqual({ kind: 'vertical', w: 1080, h: 1920 })
    }
    expect(exportFormat({ resolution: '1440p', fps: 30, format: 'horizontal' })).toEqual({ kind: 'horizontal', w: 2560, h: 1440 })
  })

  it('taxa de bits do vertical: 10 Mbps a 30 qps e 12 a 60, em qualquer resolução', () => {
    for (const resolution of ['1080p', '1440p', '2160p'] as const) {
      expect(exportBitrate(resolution, 30, 'vertical')).toBe(10_000_000)
      expect(exportBitrate(resolution, 60, 'vertical')).toBe(12_000_000)
    }
    expect(exportBitrate('1080p', 30, 'horizontal')).toBe(8_000_000) // o 16:9 não mudou
    expect(exportBitrate('1080p', 30)).toBe(8_000_000)
  })

  it('o nível do H.264 do 1080×1920 a 30 e a 60 qps cabe no nível 4.0 e 4.2 (mesmo número de macroblocos do 16:9)', () => {
    expect(avcLevelIdc(1080, 1920, 30)).toBe(0x28)
    expect(avcLevelIdc(1080, 1920, 60)).toBe(0x2a)
    expect(avcCodecString(1080, 1920, 30)).toMatch(/^avc1\.64/)
  })

  it('o nome padrão do vertical é "<título> - Vertical" (60 qps: " 60")', () => {
    expect(defaultExportStem('Meu vídeo', { resolution: '1080p', fps: 30, format: 'vertical' })).toBe('Meu vídeo - Vertical')
    expect(defaultExportStem('Meu vídeo', { resolution: '1080p', fps: 60, format: 'vertical' })).toBe('Meu vídeo - Vertical 60')
    expect(exportFileName('Meu vídeo', { resolution: '1080p', fps: 30, format: 'vertical' })).toBe('Meu vídeo - Vertical.mp4')
    expect(exportFileName('Meu vídeo', { resolution: '1080p', fps: 30 })).toBe('Meu vídeo - YouTube 1080p.mp4') // o 16:9 não mudou
    expect(exportFileName('Meu vídeo', { resolution: '1080p', fps: 30, format: 'vertical', fileName: 'tiktok-01' })).toBe('tiktok-01.mp4')
  })

  it('o pedido que atravessa a IPC aceita o formato e recusa o que não existe', () => {
    const ok = { projectId: 'p1', resolution: '1080p' as const, fps: 30 as const }
    expect(exportRequestSchema.parse({ ...ok, format: 'vertical' }).format).toBe('vertical')
    expect(exportRequestSchema.parse(ok).format).toBeUndefined()
    expect(() => exportRequestSchema.parse({ ...ok, format: 'quadrado' })).toThrow()
  })
})
