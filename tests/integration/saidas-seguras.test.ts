/**
 * Saídas dos processos externos (ffmpeg) NUNCA vão parar fora do projeto, mesmo com o projeto de terceiros plantando links:
 * toda pasta temporária é EXCLUSIVA (nome sorteado, criada agora, vazia), todo arquivo de saída passa por `resolveProjectFile`
 * e o que já existe como atalho, junção ou link físico é recusado com o motivo. Com o ffmpeg de verdade. Sem Electron.
 *
 * Cada teste planta o link NO LUGAR em que o código antigo escrevia (o nome previsível `media/.tmp-<passo>-<PID>/…`, o
 * `media/screen.mp4.parcial`, o destino final) e prova que o arquivo de fora continua intacto.
 */
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDerivedMedia, LEVELS_PATH, PEAKS_PATH, PREVIEW_AUDIO_PATH, THUMBS_DIR } from '../../src/main/derived-media'
import { createMemoryLogger } from '../../src/main/logger'
import type { RecordingManifest } from '../../src/main/manifest'
import { createProcessContext, runProcessing } from '../../src/main/processing'
import { createProjectStore } from '../../src/main/projects'
import { copyTree, FIX, requireFfmpeg, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()
const ID = '2026-10-04 1500 Projeto de exemplo'
const ff = requireFfmpeg()
const INTACT = 'NAO MEXER'

/** Um arquivo de fora do projeto com conteúdo conhecido. */
function outsideFile(name: string): string {
  const file = join(tmp(), name)
  writeFileSync(file, INTACT)
  return file
}

/** Planta `link` (dentro do projeto) como link físico do arquivo de fora. */
function hardlinkTo(outside: string, link: string): void {
  mkdirSync(join(link, '..'), { recursive: true })
  linkSync(outside, link)
}

function seed() {
  const base = tmp()
  const root = join(base, 'projetos')
  mkdirSync(root)
  const dir = join(root, ID)
  copyTree(FIX.exemplo, dir)
  const logger = createMemoryLogger()
  const store = createProjectStore({ root: () => root, logger, trash: async () => undefined, openFolder: async () => undefined })
  const derived = createDerivedMedia({ logger, ffmpeg: () => ff, read: (id) => store.read(id) })
  return { dir, logger, derived }
}

const leftovers = (dir: string): string[] => readdirSync(join(dir, 'media')).filter((n) => n.startsWith('.tmp'))
/** O arquivo de fora continua com o conteúdo original? (booleano: um arquivo reescrito pelo ffmpeg é binário e não deve ir para a saída do teste) */
const intact = (file: string): boolean => readFileSync(file).equals(Buffer.from(INTACT))

describe('mídias derivadas: o link plantado no nome previsível da pasta temporária antiga', () => {
  it('forma de onda: o voz.pcm plantado como link físico NÃO é sobrescrito pela saída do ffmpeg', async () => {
    const { derived, dir } = seed()
    const outside = outsideFile('fora-voz.pcm')
    hardlinkTo(outside, join(dir, 'media', `.tmp-peaks-${process.pid}`, 'voz.pcm'))
    const peaks = await derived.peaks(ID)
    expect(intact(outside), 'a saída do ffmpeg foi gravada por cima do arquivo de fora').toBe(true)
    expect(peaks, 'a forma de onda continua saindo').not.toBeNull()
  }, 60_000)

  it('áudio da prévia: o gráfico de filtros e o m4a plantados como links físicos NÃO são sobrescritos', async () => {
    const { derived, dir } = seed()
    const files = { 'medir.txt': outsideFile('fora-1.txt'), 'final.txt': outsideFile('fora-2.txt'), 'voice-preview.m4a': outsideFile('fora-3.m4a') }
    for (const [name, outside] of Object.entries(files)) hardlinkTo(outside, join(dir, 'media', `.tmp-preview-${process.pid}`, name))
    const preview = await derived.previewAudio(ID)
    for (const [name, outside] of Object.entries(files)) expect(intact(outside), `${name} de fora foi sobrescrito`).toBe(true)
    expect(preview, 'o áudio da prévia continua saindo').not.toBeNull()
  }, 120_000)

  it('nível do áudio: o mic.pcm e o sys.pcm plantados como links físicos NÃO são sobrescritos', async () => {
    const { derived, dir } = seed()
    const mic = outsideFile('fora-mic.pcm')
    const sys = outsideFile('fora-sys.pcm')
    hardlinkTo(mic, join(dir, 'media', `.tmp-levels-${process.pid}`, 'mic.pcm'))
    hardlinkTo(sys, join(dir, 'media', `.tmp-levels-${process.pid}`, 'sys.pcm'))
    const levels = await derived.levels(ID)
    expect(intact(mic)).toBe(true)
    expect(intact(sys)).toBe(true)
    expect(levels).not.toBeNull()
  }, 60_000)

  it('miniaturas: a pasta temporária plantada como junção para fora não recebe nenhuma miniatura', async () => {
    const { derived, dir } = seed()
    const outside = join(tmp(), 'pasta-de-fora')
    mkdirSync(outside)
    mkdirSync(join(dir, 'media'), { recursive: true })
    symlinkSync(outside, join(dir, 'media', `.tmp-thumbs-${process.pid}`), 'junction')
    const thumbs = await derived.thumbs(ID)
    expect(readdirSync(outside), 'miniaturas foram parar fora do projeto').toEqual([])
    expect(thumbs).not.toBeNull()
    expect(existsSync(join(dir, THUMBS_DIR, 'thumb-0000.jpg'))).toBe(true)
  }, 60_000)

  it('nada sobra em media/ no fim (pasta temporária some, com ou sem sucesso)', async () => {
    const { derived, dir } = seed()
    await derived.peaks(ID)
    await derived.levels(ID)
    await derived.thumbs(ID)
    expect(leftovers(dir)).toEqual([])
  }, 90_000)
})

describe('mídias derivadas: o destino final que já é link é recusado, com o motivo, e o arquivo de fora fica intacto', () => {
  it.each([
    ['a forma de onda', PEAKS_PATH, (d: ReturnType<typeof seed>['derived']) => d.peaks(ID), /forma de onda/],
    ['o nível do áudio', LEVELS_PATH, (d: ReturnType<typeof seed>['derived']) => d.levels(ID), /nível do áudio/],
    ['o áudio da prévia', PREVIEW_AUDIO_PATH, (d: ReturnType<typeof seed>['derived']) => d.previewAudio(ID), /áudio da prévia/]
  ])('%s: %s plantado como link físico', async (_label, rel, run, shown) => {
    const { derived, dir, logger } = seed()
    const outside = outsideFile('fora-destino.bin')
    hardlinkTo(outside, join(dir, rel))
    await expect(run(derived)).rejects.toThrow(shown)
    expect(intact(outside), 'o destino final foi escrito por cima do arquivo de fora').toBe(true)
    expect(logger.entries.some((e) => e.level === 'warn' && /link/i.test(e.message)), 'a recusa tem que ficar no log').toBe(true)
    expect(leftovers(dir)).toEqual([])
  }, 120_000)

  it('as miniaturas: media/thumbs que é uma junção (mesmo para DENTRO do projeto) é recusada', async () => {
    const { derived, dir } = seed()
    const inside = join(dir, 'media', 'outra-pasta')
    mkdirSync(inside, { recursive: true })
    symlinkSync(inside, join(dir, THUMBS_DIR), 'junction')
    await expect(derived.thumbs(ID)).rejects.toThrow(/miniaturas/)
    expect(readdirSync(inside), 'as miniaturas foram parar atrás da junção').toEqual([])
  }, 60_000)
})

// --- processamento ao parar a gravação ---------------------------------------------------------------------
function newRecording(opts: { camera?: boolean } = {}) {
  const dir = join(tmp(), 'gravacao')
  mkdirSync(join(dir, 'raw'), { recursive: true })
  writeFileSync(join(dir, 'raw', 'screen.webm'), readFileSync(FIX.telaVfr))
  if (opts.camera) writeFileSync(join(dir, 'raw', 'camera.webm'), readFileSync(FIX.camera))
  const manifest: RecordingManifest = {
    version: 1,
    sessionId: 'sessao-de-teste',
    folder: 'gravacao',
    title: 'Teste',
    createdAt: '2026-10-06T10:00:00.000Z',
    mode: opts.camera ? 'screen-camera' : 'screen',
    fps: 30,
    screen: { file: 'raw/screen.webm', kind: 'screen', sourceId: 'screen:0:0', sourceName: 'Tela 1', scale: 1, mime: null, hasSystemAudio: false, cursorHidden: false, frame: null, frameEnd: null, screenRect: null },
    camera: opts.camera ? { file: 'raw/camera.webm', mime: null, hasVideo: true, hasAudio: true, size: null } : null,
    clock: null,
    pauses: [],
    endedAt: null,
    stopReason: null,
    recordedMs: null,
    notes: [],
    saved: null,
    processedAt: null
  }
  const logger = createMemoryLogger()
  // "salvar" e "project" já estão feitos: o que se prova aqui são os passos de mídia
  const ctx = createProcessContext({ dir, manifest, rawEvents: null })
  ctx.done.add('save')
  ctx.done.add('project')
  const run = () => runProcessing(ctx, { ff, logger, onProgress: () => undefined })
  return { dir, logger, run }
}

describe('processamento da gravação: as saídas do ffmpeg não passam por nome previsível', () => {
  it('os parciais plantados (screen.mp4.parcial, camera.mp4.parcial) como links físicos NÃO são sobrescritos', async () => {
    const { dir, run } = newRecording({ camera: true })
    const a = outsideFile('fora-a.bin')
    const b = outsideFile('fora-b.bin')
    mkdirSync(join(dir, 'media'), { recursive: true })
    linkSync(a, join(dir, 'media', 'screen.mp4.parcial'))
    linkSync(b, join(dir, 'media', 'camera.mp4.parcial'))
    const snap = await run()
    expect(intact(a), 'o parcial da tela foi escrito por cima do arquivo de fora').toBe(true)
    expect(intact(b), 'o parcial da câmera foi escrito por cima do arquivo de fora').toBe(true)
    expect(snap.status, snap.error?.message).toBe('done')
    expect(existsSync(join(dir, 'media', 'screen.mp4'))).toBe(true)
    expect(leftovers(dir)).toEqual([])
  }, 180_000)

  it.each([
    ['voice', 'media/voice.wav', true],
    ['thumb', 'media/thumb.jpg', false]
  ])('o destino final plantado como link físico (%s: %s) é recusado e o arquivo de fora fica intacto', async (step, rel, camera) => {
    const { dir, run } = newRecording({ camera })
    const outside = outsideFile('fora-final.bin')
    hardlinkTo(outside, join(dir, rel))
    const snap = await run()
    expect(intact(outside), 'o ffmpeg escreveu por cima do arquivo de fora').toBe(true)
    expect(snap.status).toBe('failed')
    expect(snap.error?.step).toBe(step)
    expect(snap.error?.message).toMatch(/link/i)
    expect(leftovers(dir)).toEqual([])
  }, 180_000)

  it('uma gravação normal termina sem sobra e com todos os arquivos', async () => {
    const { dir, run } = newRecording({ camera: true })
    const snap = await run()
    expect(snap.status, snap.error?.message).toBe('done')
    for (const f of ['screen.mp4', 'camera.mp4', 'voice.wav', 'thumb.jpg']) expect(existsSync(join(dir, 'media', f)), f).toBe(true)
    expect(readdirSync(join(dir, 'media')).sort()).toEqual(['camera.mp4', 'screen.mp4', 'thumb.jpg', 'voice.wav'])
  }, 180_000)

  it('media/ que é uma junção para fora: o passo falha com o motivo e nada é escrito fora', async () => {
    const { dir, run } = newRecording()
    const outside = join(tmp(), 'media-de-fora')
    mkdirSync(outside)
    symlinkSync(outside, join(dir, 'media'), 'junction')
    const snap = await run()
    expect(readdirSync(outside), 'a mídia foi parar fora da pasta da gravação').toEqual([])
    expect(snap.status).toBe('failed')
    expect(snap.error?.message).toMatch(/fora da pasta/)
  }, 120_000)
})
