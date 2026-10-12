/**
 * O recorte em PEDAÇOS (R1), parte pura: o andamento guardado no projeto, a conferência dos pedaços e o ESTADO ÚNICO que a interface
 * consulta (`matteStatusOf`). O comportamento do serviço (retomar, esperar a placa, avisar) está em `integration/camera-recorte-retoma`.
 */
import { describe, expect, it } from 'vitest'
import {
  chunksFraction,
  contiguousChunks,
  MATTE_CHUNK_SECONDS,
  MATTE_PROGRESS_VERSION,
  matteChunkName,
  matteStatusOf,
  parseMatteProgress,
  progressMatchesCamera,
  type MatteProgress
} from '@shared/matte-parts'
import { parseFfmpegDuration } from '../../src/main/camera/matte-join'

const progress = (patch: Partial<MatteProgress> = {}): MatteProgress => ({
  version: MATTE_PROGRESS_VERSION,
  source: 'media/camera.mp4',
  sourceMtimeMs: 1000,
  chunkSeconds: MATTE_CHUNK_SECONDS,
  chunks: [
    { index: 0, frames: 300, bytes: 100 },
    { index: 1, frames: 300, bytes: 100 }
  ],
  status: 'interrupted',
  fraction: 0.4,
  attempts: 2,
  startedAt: '2026-10-12T10:00:00.000Z',
  updatedAt: '2026-10-12T10:00:30.000Z',
  ...patch
})

describe('pedaços do recorte', () => {
  it('os nomes dos pedaços são p0000.mp4, p0001.mp4… (ordem alfabética = ordem do vídeo)', () => {
    expect(matteChunkName(0)).toBe('p0000.mp4')
    expect(matteChunkName(12)).toBe('p0012.mp4')
    expect([matteChunkName(10), matteChunkName(9), matteChunkName(2)].sort()).toEqual(['p0002.mp4', 'p0009.mp4', 'p0010.mp4'])
  })

  it('só vale o trecho de pedaços prontos que começa no 0 e não tem buraco', () => {
    expect(contiguousChunks([{ index: 0 }, { index: 1 }, { index: 2 }])).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }])
    expect(contiguousChunks([{ index: 2 }, { index: 0 }, { index: 1 }, { index: 4 }])).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }])
    expect(contiguousChunks([{ index: 1 }, { index: 2 }])).toEqual([])
    expect(contiguousChunks([])).toEqual([])
  })

  it('o andamento guardado volta igual; lixo, outra versão e campos faltando viram "não há andamento"', () => {
    const p = progress()
    expect(parseMatteProgress(JSON.stringify(p))).toEqual(p)
    expect(parseMatteProgress('{')).toBeNull()
    expect(parseMatteProgress('null')).toBeNull()
    expect(parseMatteProgress(JSON.stringify({ ...p, version: 99 }))).toBeNull()
    expect(parseMatteProgress(JSON.stringify({ ...p, source: 5 }))).toBeNull()
    expect(parseMatteProgress(JSON.stringify({ ...p, chunks: 'x' }))).toBeNull()
  })

  it('ao ler, pedaço com buraco ou sem quadros não conta, e o estado desconhecido vira "running"', () => {
    const p = parseMatteProgress(
      JSON.stringify({ ...progress(), status: 'qualquer', chunks: [{ index: 0, frames: 300, bytes: 1 }, { index: 1, frames: 0, bytes: 1 }, { index: 2, frames: 300, bytes: 1 }, { index: -1, frames: 3 }] })
    )!
    expect(p.status).toBe('running')
    expect(p.chunks.map((c) => c.index)).toEqual([0])
  })

  it('os pedaços só valem para a MESMA câmera (arquivo e data) e o mesmo tamanho de pedaço', () => {
    const p = progress()
    expect(progressMatchesCamera(p, 'media/camera.mp4', 1000)).toBe(true)
    expect(progressMatchesCamera(p, 'media/outra.mp4', 1000)).toBe(false)
    expect(progressMatchesCamera(p, 'media/camera.mp4', 1001)).toBe(false)
    expect(progressMatchesCamera(p, 'media/camera.mp4', 1000, 5)).toBe(false)
  })

  it('"retomando de N%" sai dos pedaços prontos e nunca chega a 100% antes de terminar', () => {
    expect(chunksFraction(0, 10, 88_000)).toBe(0)
    expect(chunksFraction(5, 10, 100_000)).toBeCloseTo(0.5)
    expect(chunksFraction(9, 10, 88_200)).toBeCloseTo(0.99)
    expect(chunksFraction(3, 10, 0)).toBe(0)
  })

  it('a duração que o ffmpeg escreve no cabeçalho é lida em segundos', () => {
    expect(parseFfmpegDuration('  Duration: 00:01:28.20, start: 0.000000, bitrate: 3 kb/s')).toBeCloseTo(88.2)
    expect(parseFfmpegDuration('Duration: 01:00:00.00, start')).toBe(3600)
    expect(parseFfmpegDuration('sem duração')).toBeNull()
  })
})

describe('matteStatusOf: o estado único do recorte', () => {
  it('pronto: a URL vale, e ganha de qualquer trabalho antigo', () => {
    expect(matteStatusOf({ url: 'tomada-media://x', job: { state: 'done', fraction: 1, url: 'tomada-media://x' } })).toMatchObject({ state: 'ready', fraction: 1, percent: 100, url: 'tomada-media://x', error: null })
    expect(matteStatusOf({ url: 'tomada-media://x' })).toMatchObject({ state: 'ready', percent: 100 })
    // o trabalho acabou de terminar e a leitura do projeto ainda não trouxe a URL: o trabalho conta
    expect(matteStatusOf({ url: null, job: { state: 'done', fraction: 1, url: 'tomada-media://y' } })).toMatchObject({ state: 'ready', url: 'tomada-media://y' })
  })

  it('em andamento: porcentagem inteira, e "continuando" quando vem de pedaços que já estavam prontos', () => {
    expect(matteStatusOf({ url: null, job: { state: 'running', fraction: 0.634 } })).toMatchObject({ state: 'running', fraction: 0.634, percent: 63, resumed: false, waiting: null })
    expect(matteStatusOf({ url: null, job: { state: 'running', fraction: 0.5, resumed: true } })).toMatchObject({ state: 'running', percent: 50, resumed: true })
    // o recorte velho que ainda aparece como pronto não esconde o novo em andamento (o "Recortar de novo")
    expect(matteStatusOf({ url: 'tomada-media://velho', job: { state: 'running', fraction: 0.2 } }).state).toBe('running')
  })

  it('na fila: esperando a vez ou dando lugar à placa (exportação, transcrição, prévia)', () => {
    expect(matteStatusOf({ url: null, job: { state: 'queued', fraction: 0 } })).toMatchObject({ state: 'queued', waiting: 'queue' })
    expect(matteStatusOf({ url: null, job: { state: 'queued', fraction: 0.31, waiting: 'gpu', resumed: true } })).toMatchObject({ state: 'queued', waiting: 'gpu', percent: 31, resumed: true })
  })

  it('falhou: o motivo vem junto (e sem motivo há um padrão); cancelado ou nunca pedido é "none"', () => {
    expect(matteStatusOf({ url: null, job: { state: 'error', fraction: 0, error: 'sem ffmpeg' } })).toMatchObject({ state: 'failed', error: 'sem ffmpeg' })
    expect(matteStatusOf({ url: null, job: { state: 'error', fraction: 0 } }).error).toMatch(/recorte/i)
    expect(matteStatusOf({ url: null, job: { state: 'cancelled', fraction: 0.2 } })).toMatchObject({ state: 'none', percent: 0 })
    expect(matteStatusOf({ url: null })).toMatchObject({ state: 'none', fraction: 0, percent: 0, url: null })
  })

  it('a fração é sempre limitada a 0..1', () => {
    expect(matteStatusOf({ url: null, job: { state: 'running', fraction: 1.7 } })).toMatchObject({ fraction: 1, percent: 100 })
    expect(matteStatusOf({ url: null, job: { state: 'running', fraction: -2 } })).toMatchObject({ fraction: 0, percent: 0 })
  })
})
