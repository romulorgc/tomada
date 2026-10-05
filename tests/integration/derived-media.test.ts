/**
 * Mídias derivadas do editor (forma de onda, voz tratada da prévia, miniaturas): geradas UMA vez pelo ffmpeg,
 * guardadas no projeto, refeitas só quando a fonte muda, sem deixar temporário e com falha que aparece.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PEAKS_PATH, PREVIEW_AUDIO_INFO, PREVIEW_AUDIO_PATH, THUMBS_DIR, createDerivedMedia, thumbIntervalMs, THUMB_HEIGHT } from '../../src/main/derived-media'
import type { Ffmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { createProjectStore } from '../../src/main/projects'
import { parseProject, serializeProject } from '../../src/shared/project'
import { copyTree, FIX, requireFfmpeg, useTmpDir } from '../helpers/env'
import { probeJson } from '../helpers/media'

const tmp = useTmpDir()
const ID = '2026-10-04 1500 Projeto de exemplo'

/** Raiz com o projeto de exemplo, o armazenamento e um ffmpeg que conta quantas vezes foi chamado. */
function seed(opts: { ffmpeg?: boolean } = {}) {
  const base = tmp()
  const root = join(base, 'projetos')
  mkdirSync(root)
  const dir = join(root, ID)
  copyTree(FIX.exemplo, dir)
  const logger = createMemoryLogger()
  const store = createProjectStore({ root: () => root, logger, trash: async () => undefined, openFolder: async () => undefined })
  const real = requireFfmpeg()
  const calls: string[][] = []
  const counting: Ffmpeg = { ...real, run: async (args, o) => (calls.push(args), real.run(args, o)) }
  const derived = createDerivedMedia({ logger, ffmpeg: () => (opts.ffmpeg === false ? null : counting), read: (id) => store.read(id) })
  return { dir, root, logger, store, derived, calls }
}

const tmpLeftovers = (dir: string): string[] => readdirSync(join(dir, 'media')).filter((n) => n.startsWith('.tmp'))

describe('thumbIntervalMs', () => {
  it('~40 miniaturas por vídeo, entre 1,5 s e 10 s', () => {
    expect(thumbIntervalMs(23_000)).toBe(1500)
    expect(thumbIntervalMs(600_000)).toBe(10_000)
    expect(thumbIntervalMs(120_000)).toBe(3000)
    expect(thumbIntervalMs(1000)).toBe(1500)
  })
})

describe('forma de onda (peaks.json)', () => {
  it('calcula os picos uma vez, guarda no projeto e reaproveita enquanto a voz não muda', async () => {
    const { dir, derived, calls } = seed()
    const first = await derived.peaks(ID)
    expect(first).not.toBeNull()
    expect(first!.perSecond).toBe(50)
    expect(first!.durationMs).toBeGreaterThan(22_600)
    expect(first!.durationMs).toBeLessThan(22_800)
    expect(Math.abs(first!.peaks.length - (first!.durationMs / 1000) * 50)).toBeLessThanOrEqual(2)
    expect(first!.peaks.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)).toBe(true)
    expect(Math.max(...first!.peaks)).toBeGreaterThan(50) // tem fala
    expect(first!.peaks.filter((p) => p < 6).length).toBeGreaterThan(20) // e tem silêncio
    expect(existsSync(join(dir, PEAKS_PATH))).toBe(true)
    expect(calls).toHaveLength(1)
    expect(tmpLeftovers(dir)).toEqual([])

    // de novo: do disco, sem ffmpeg
    const again = await derived.peaks(ID)
    expect(again).toEqual(first)
    expect(calls).toHaveLength(1)
  })

  it('refaz quando o arquivo de voz muda (data do arquivo)', async () => {
    const { dir, derived, calls } = seed()
    await derived.peaks(ID)
    const voice = join(dir, 'media', 'voice.wav')
    const t = new Date(Date.now() + 60_000)
    utimesSync(voice, t, t)
    await derived.peaks(ID)
    expect(calls).toHaveLength(2)
  })

  it('o mesmo pedido feito duas vezes ao mesmo tempo roda o ffmpeg uma vez só', async () => {
    const { derived, calls } = seed()
    const [a, b] = await Promise.all([derived.peaks(ID), derived.peaks(ID)])
    expect(a).toEqual(b)
    expect(calls).toHaveLength(1)
  })

  it('sem ffmpeg e sem cache devolve null (o editor segue sem a onda); com cache, devolve o cache', async () => {
    const withFf = seed()
    await withFf.derived.peaks(ID)
    const noFf = createDerivedMedia({ logger: withFf.logger, ffmpeg: () => null, read: (id) => withFf.store.read(id) })
    expect(await noFf.peaks(ID)).not.toBeNull()

    const bare = seed({ ffmpeg: false })
    expect(await bare.derived.peaks(ID)).toBeNull()
  })

  it('voz que não existe no disco: null e aviso no log; voz corrompida: ERRO com o motivo e sem temporário', async () => {
    const missing = seed()
    renameSync(join(missing.dir, 'media', 'voice.wav'), join(missing.dir, 'media', 'sumiu.wav'))
    expect(await missing.derived.peaks(ID)).toBeNull()
    expect(missing.logger.entries.some((e) => e.level === 'warn' && e.message.includes('voz'))).toBe(true)

    const broken = seed()
    writeFileSync(join(broken.dir, 'media', 'voice.wav'), 'isto não é áudio')
    await expect(broken.derived.peaks(ID)).rejects.toThrow(/Não consegui preparar a forma de onda/)
    expect(broken.logger.entries.some((e) => e.level === 'warn')).toBe(true)
    expect(tmpLeftovers(broken.dir)).toEqual([])
    expect(existsSync(join(broken.dir, PEAKS_PATH))).toBe(false)
  })

  it('projeto sem voz: null', async () => {
    const s = seed()
    const file = join(s.dir, 'project.json')
    const p = parseProject(readFileSync(file, 'utf8'))
    delete p.sources.voice
    writeFileSync(file, serializeProject(p))
    expect(await s.derived.peaks(ID)).toBeNull()
  })
})

describe('áudio da prévia (voice-preview.m4a)', () => {
  it('gera a voz tratada sem cortes, com a duração do projeto, e não refaz enquanto nada muda', async () => {
    const { dir, derived, calls } = seed()
    const r = await derived.previewAudio(ID)
    expect(r).not.toBeNull()
    expect(r!.url).toContain('tomada-media://')
    expect(r!.url).toContain('voice-preview.m4a')
    const file = join(dir, PREVIEW_AUDIO_PATH)
    expect(existsSync(file)).toBe(true)
    const probe = probeJson(file)
    const audio = probe.streams.filter((x) => x.codec_type === 'audio')
    expect(audio).toHaveLength(1)
    expect(audio[0]!.codec_name).toBe('aac')
    expect(Math.abs(Number(probe.format.duration) * 1000 - 23_000)).toBeLessThan(250) // a do projeto (a voz tem 22,69 s: o resto é silêncio)
    expect(existsSync(join(dir, PREVIEW_AUDIO_INFO))).toBe(true)
    expect(calls).toHaveLength(2) // medir + gerar (dois passes)
    expect(tmpLeftovers(dir)).toEqual([])

    const mtime = statSync(file).mtimeMs
    const again = await derived.previewAudio(ID)
    expect(again!.url).toBe(r!.url)
    expect(calls).toHaveLength(2)
    expect(statSync(file).mtimeMs).toBe(mtime)
  })

  it('refaz quando o deslocamento da voz muda no projeto', async () => {
    const s = seed()
    await s.derived.previewAudio(ID)
    const file = join(s.dir, 'project.json')
    const p = parseProject(readFileSync(file, 'utf8'))
    p.sync.cameraOffsetMs = 120
    writeFileSync(file, serializeProject(p))
    await s.derived.previewAudio(ID)
    expect(s.calls).toHaveLength(4)
  })

  it('sem nenhum áudio no projeto: null, sem chamar o ffmpeg', async () => {
    const s = seed()
    const file = join(s.dir, 'project.json')
    const p = parseProject(readFileSync(file, 'utf8'))
    delete p.sources.voice
    writeFileSync(file, serializeProject(p))
    expect(await s.derived.previewAudio(ID)).toBeNull()
    expect(s.calls).toHaveLength(0)
  })
})

describe('miniaturas (media/thumbs)', () => {
  it('gera uma a cada intervalo, na altura certa, e reaproveita', async () => {
    const { dir, derived, calls } = seed()
    const r = await derived.thumbs(ID)
    expect(r).not.toBeNull()
    expect(r!.intervalMs).toBe(1500)
    expect(r!.height).toBe(THUMB_HEIGHT)
    expect(r!.count).toBeGreaterThanOrEqual(15)
    expect(r!.count).toBeLessThanOrEqual(17)
    expect(r!.urls).toHaveLength(r!.count)
    const files = readdirSync(join(dir, THUMBS_DIR)).filter((n) => n.endsWith('.jpg'))
    expect(files).toHaveLength(r!.count)
    const probe = probeJson(join(dir, THUMBS_DIR, files[0]!))
    expect(probe.streams[0]!.height).toBe(THUMB_HEIGHT)
    expect(tmpLeftovers(dir)).toEqual([])
    expect(calls).toHaveLength(1)

    const again = await derived.thumbs(ID)
    expect(again).toEqual(r)
    expect(calls).toHaveLength(1)
  })

  it('refaz se a pasta de miniaturas sumiu ou a tela mudou', async () => {
    const s = seed()
    await s.derived.thumbs(ID)
    const t = new Date(Date.now() + 60_000)
    utimesSync(join(s.dir, 'media', 'screen.mp4'), t, t)
    await s.derived.thumbs(ID)
    expect(s.calls).toHaveLength(2)
  })

  it('tela que não abre: ERRO com o motivo e nenhuma pasta pela metade', async () => {
    const s = seed()
    writeFileSync(join(s.dir, 'media', 'screen.mp4'), 'isto não é um vídeo')
    await expect(s.derived.thumbs(ID)).rejects.toThrow(/Não consegui preparar as miniaturas/)
    expect(tmpLeftovers(s.dir)).toEqual([])
    expect(existsSync(join(s.dir, THUMBS_DIR))).toBe(false)
  })
})

describe('fila e encerramento', () => {
  it('as tarefas rodam uma de cada vez, e idle() espera todas', async () => {
    const s = seed()
    const done: string[] = []
    const all = [s.derived.peaks(ID).then(() => done.push('peaks')), s.derived.thumbs(ID).then(() => done.push('thumbs')), s.derived.previewAudio(ID).then(() => done.push('audio'))]
    await s.derived.idle()
    await Promise.all(all)
    expect(done).toEqual(['peaks', 'thumbs', 'audio']) // ordem do pedido: a fila é de um
  })

  it('shutdown() interrompe o que está rodando sem erro para quem pediu depois', async () => {
    const s = seed()
    const pending = s.derived.previewAudio(ID)
    s.derived.shutdown()
    // interrompido: devolve null ou rejeita, mas termina (não pendura) e não deixa temporário
    await Promise.race([pending.catch(() => null), new Promise((_, rej) => setTimeout(() => rej(new Error('pendurou')), 20_000))])
    await new Promise((r) => setTimeout(r, 400))
    expect(tmpLeftovers(s.dir)).toEqual([])
  })
})
