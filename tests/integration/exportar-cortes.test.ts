/**
 * Exportar UM corte vertical (M4b) e o texto que acompanha cada exportação, com o serviço de exportação de VERDADE
 * (áudio e mux no ffmpeg real, conferência por ffprobe) e uma janela de vídeo simulada: o corte vem do documento (nunca da
 * interface), sai em `exports/cortes/<n> - <título>.mp4` com um `.txt` ao lado, o 16:9 grava `<título> - YouTube.txt`, e
 * nada é sobrescrito.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clipDocument } from '@shared/clips'
import { outputFrameCount } from '@shared/export'
import type { ExportJob, ExportProgress, ExportRequest } from '@shared/ipc'
import { parseProject, projectDurationMs, serializeProject } from '@shared/project'
import { keptRanges, outputDuration } from '@shared/timeline'
import type { Clip, Project } from '@shared/types'
import { createExportService, type ExportService } from '../../src/main/export-service'
import { createMemoryLogger } from '../../src/main/logger'
import { createOutputDirs } from '../../src/main/path-guard'
import { createProjectStore } from '../../src/main/projects'
import { parseTranscript } from '../../src/shared/transcript'
import { copyTree, FIX, requireFfmpeg, useTmpDir } from '../helpers/env'
import { ensureLongProject, LONG_FOLDER, LONG_MS } from '../helpers/long-project'
import { probeJson } from '../helpers/media'
import { buildDemo } from '../helpers/demo-script'

const tmp = useTmpDir()
const ID = 'exemplo'

const clipOf = (over: Partial<Clip> = {}): Clip => ({
  id: 'clip-1',
  title: 'Gravar a tela em segundos',
  hook: 'Grave a tela em segundos',
  ranges: [{ start: 400, end: 5800 }],
  score: 80,
  reason: 'teste',
  format: 'vertical',
  layoutV: 'auto',
  ...over
})

/** Vídeo mudo H.264 de 30 qps com exatamente `frames` quadros (o que a janela escondida entregaria), na proporção 9:16. */
function fakeVideo(file: string, frames: number): Buffer {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=30', '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', file], { windowsHide: true })
  return readFileSync(file)
}

type Which = 'exemplo' | 'longo'

async function build(mutate?: (p: Project) => void, which: Which = 'exemplo') {
  const base = tmp()
  const root = join(base, 'projetos')
  const id = which === 'longo' ? LONG_FOLDER : ID
  const dir = join(root, id)
  copyTree(which === 'longo' ? ensureLongProject() : FIX.exemplo, dir)
  if (which === 'longo') {
    // a demonstração narrada de 3 min (sintética) como transcrição: dá para ter 3 capítulos de pelo menos 10 s
    const demo = buildDemo({ maxMs: LONG_MS - 2000 })
    writeFileSync(join(dir, 'transcript.json'), JSON.stringify({ engine: 'teste', model: 'mock', language: 'pt', durationMs: LONG_MS, words: demo.words, segments: [], vad: [], createdAt: '2026-10-05T10:00:00.000Z' }))
  }
  if (mutate) {
    const p = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    mutate(p)
    writeFileSync(join(dir, 'project.json'), serializeProject(p))
  }
  const logger = createMemoryLogger()
  const store = createProjectStore({ root: () => root, logger, trash: async () => undefined, openFolder: async () => undefined })
  const ff = requireFfmpeg()
  const events: ExportProgress[] = []
  const jobs: ExportJob[] = []
  const ref: { svc: ExportService | null } = { svc: null }
  const exporter = createExportService({
    logger,
    outputDirs: createOutputDirs(),
    read: (id) => store.read(id),
    words: async () => parseTranscript(readFileSync(join(dir, 'transcript.json'), 'utf8')).words,
    ffmpeg: () => ff,
    openExporterWindow: (id) => {
      const svc = ref.svc!
      setTimeout(() => {
        void (async () => {
          const job = svc.job(id)
          jobs.push(job)
          const frames = outputFrameCount(outputDuration(projectDurationMs(job.project), job.project.cuts), job.fps)
          await svc.write(id, 0, new Uint8Array(fakeVideo(join(base, `video-${id.slice(0, 6)}.mp4`), frames)))
          svc.finish(id, { ok: true, frames, encoder: 'teste' })
        })()
      }, 20)
      return { destroy: () => undefined }
    },
    emit: (p) => events.push(p),
    now: () => performance.now()
  })
  ref.svc = exporter
  const request = (over: Partial<ExportRequest> = {}): ExportRequest => ({ projectId: id, resolution: '1080p', fps: 30, ...over })
  const run = async (req: ExportRequest): Promise<ExportProgress> => {
    const { exportId } = await exporter.start(req)
    await exporter.idle()
    const last = [...events].reverse().find((e) => e.exportId === exportId)
    if (!last) throw new Error('sem progresso')
    return last
  }
  return { base, dir, exporter, events, jobs, request, run, store, id }
}

describe('exportar um corte vertical', () => {
  it('sai em exports/cortes/<n> - <título>.mp4 (1080×1920, com áudio) e o .txt de legenda e hashtags ao lado', async () => {
    const { dir, jobs, request, run } = await build((p) => {
      p.clips = [clipOf()]
      p.meta = { perClip: { 'clip-1': { caption: 'Grave sua tela em segundos.', tiktok: ['#gravacao', '#tela'], reels: ['#gravacao'], shorts: ['#tutorial', '#Shorts'] } } }
    })
    const done = await run(request({ clipId: 'clip-1' }))
    expect(done.message ?? '').toBe('')
    expect(done.phase).toBe('done')
    expect(done.clipId).toBe('clip-1')
    expect(done.outputPath).toBe(join(dir, 'exports', 'cortes', '01 - Gravar a tela em segundos.mp4'))
    expect(done.textPath).toBe(join(dir, 'exports', 'cortes', '01 - Gravar a tela em segundos.txt'))
    expect(readdirSync(join(dir, 'exports', 'cortes')).sort()).toEqual(['01 - Gravar a tela em segundos.mp4', '01 - Gravar a tela em segundos.txt'])
    expect(readFileSync(done.textPath!, 'utf8')).toBe(
      ['Gravar a tela em segundos', 'Gancho: Grave a tela em segundos', '', 'Legenda:', 'Grave sua tela em segundos.', '', 'TikTok: #gravacao #tela', 'Reels: #gravacao', 'Shorts: #tutorial #Shorts', ''].join('\n')
    )
    // o arquivo: vertical, vídeo e áudio, duração do corte
    const probe = probeJson(done.outputPath!)
    expect(probe.streams.find((s) => s.codec_type === 'video')).toMatchObject({ width: 180, height: 320 }) // a janela simulada entrega 180×320; o job pediu 1080×1920
    expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true)
    expect(Math.abs(Number(probe.format.duration) * 1000 - 5400)).toBeLessThan(80)
    // o que a janela de vídeo recebeu: vertical, 1080×1920, o documento do corte (cortes de fora, gancho do corte)
    const job = jobs[0]!
    expect(job).toMatchObject({ format: 'vertical', width: 1080, height: 1920, fps: 30, bitrate: 10_000_000 })
    expect(job.clipLayout).toBeUndefined() // automático
    expect(keptRanges(23_000, job.project.cuts)).toEqual([{ start: 400, end: 5800 }])
    expect(job.project.vertical!.hook).toBe('Grave a tela em segundos')
  })

  it('o layout fixo do corte vai para a janela de vídeo; o estilo de legenda do corte vale no documento', async () => {
    const { jobs, request, run } = await build((p) => {
      p.clips = [clipOf({ layoutV: 'screen-wide', captionStyle: 'clean' })]
    })
    const done = await run(request({ clipId: 'clip-1' }))
    expect(done.phase).toBe('done')
    expect(jobs[0]!.clipLayout).toBe('screen-wide')
    expect(jobs[0]!.project.vertical!.captions).toMatchObject({ enabled: true, style: 'clean' })
  })

  it('o número é a posição do corte na lista e o nome nunca sobrescreve: " (2)"', async () => {
    const { dir, request, run } = await build((p) => {
      p.clips = [clipOf(), clipOf({ id: 'clip-2', title: 'Segundo corte: “com” caracteres/ruins?', ranges: [{ start: 8000, end: 14_000 }] })]
    })
    const second = await run(request({ clipId: 'clip-2' }))
    expect(second.outputPath).toBe(join(dir, 'exports', 'cortes', '02 - Segundo corte “com” caracteres ruins.mp4'))
    const first = await run(request({ clipId: 'clip-1' }))
    const again = await run(request({ clipId: 'clip-1' }))
    expect(first.outputPath).toMatch(/01 - Gravar a tela em segundos\.mp4$/)
    expect(again.outputPath).toMatch(/01 - Gravar a tela em segundos \(2\)\.mp4$/)
    expect(again.textPath).toMatch(/01 - Gravar a tela em segundos \(2\)\.txt$/)
    expect(readdirSync(join(dir, 'exports', 'cortes')).length).toBe(6)
  })

  it('o formato e o nome pedidos pela interface não valem: o corte é sempre vertical e o nome é o do corte', async () => {
    const { jobs, request, run } = await build((p) => {
      p.clips = [clipOf()]
    })
    const done = await run(request({ clipId: 'clip-1', format: 'horizontal', fileName: '../../fora' }))
    expect(done.phase).toBe('done')
    expect(jobs[0]!.format).toBe('vertical')
    expect(done.outputPath).toMatch(/exports\\cortes\\01 - Gravar a tela em segundos\.mp4$/)
  })

  it('corte que não existe, ou sem trecho dentro da gravação, falha ANTES de começar, com o motivo', async () => {
    const { dir, request, exporter } = await build((p) => {
      p.clips = [clipOf({ id: 'clip-9', title: 'Fora', ranges: [{ start: 90_000, end: 95_000 }] })]
    })
    await expect(exporter.start(request({ clipId: 'clip-7' }))).rejects.toThrow(/Esse corte não existe mais neste projeto/)
    await expect(exporter.start(request({ clipId: 'clip-9' }))).rejects.toThrow(/O corte «Fora» não tem nenhum trecho dentro da gravação/)
    expect(existsSync(join(dir, 'exports'))).toBe(false)
  })

  it('o texto do corte sem nada guardado na aba Publicar usa o gancho e as palavras que mais aparecem', async () => {
    const { request, run } = await build((p) => {
      p.clips = [clipOf()]
    })
    const done = await run(request({ clipId: 'clip-1' }))
    const text = readFileSync(done.textPath!, 'utf8')
    expect(text).toContain('Legenda:\nGrave a tela em segundos\n')
    expect(text).toMatch(/TikTok: (#\S+ ?)+\n/)
    expect(text).toMatch(/Shorts: .*#Shorts\n/)
  })

  it('exports/ que é uma junção para fora da pasta do projeto é recusada (o corte não vai parar em outro lugar)', async () => {
    const { base, dir, request, exporter } = await build((p) => {
      p.clips = [clipOf()]
    })
    const outside = join(base, 'fora')
    mkdirSync(join(outside, 'cortes'), { recursive: true })
    symlinkSync(outside, join(dir, 'exports'), 'junction')
    await expect(exporter.start(request({ clipId: 'clip-1' }))).rejects.toThrow(/aponta para fora da pasta dele/)
    expect(readdirSync(join(outside, 'cortes'))).toEqual([])
  })

  it('a edição do corte é a do projeto: o corte herda os cortes de silêncio de dentro dele', async () => {
    const { jobs, request, run } = await build((p) => {
      p.clips = [clipOf({ ranges: [{ start: 400, end: 9000 }] })]
      p.cuts = [{ id: 'cut-1', start: 2000, end: 2600, reason: 'silence', enabled: true }, { id: 'cut-2', start: 15_000, end: 16_000, reason: 'silence', enabled: true }]
    })
    const done = await run(request({ clipId: 'clip-1' }))
    expect(done.phase).toBe('done')
    expect(keptRanges(23_000, jobs[0]!.project.cuts)).toEqual([{ start: 400, end: 2000 }, { start: 2600, end: 9000 }])
    expect(done.report!.expectedMs).toBe(8000)
    // é o MESMO documento que `clipDocument` monta
    const stored = parseProject(readFileSync(join(done.outputPath!, '..', '..', '..', 'project.json'), 'utf8'))
    expect(jobs[0]!.project.cuts).toEqual(clipDocument(stored, stored.clips[0]!).cuts)
  })

  it('a fila pede o corte seguinte NO INSTANTE do "pronto" do anterior: o pedido espera a limpeza do anterior, não é recusado', async () => {
    const { dir, exporter, events, request } = await build((p) => {
      p.clips = [clipOf(), clipOf({ id: 'clip-2', title: 'Segundo corte', ranges: [{ start: 6000, end: 12_000 }] })]
    })
    const first = await exporter.start(request({ clipId: 'clip-1' }))
    // espera o "done" do primeiro e já pede o segundo, como a fila da aba Cortes faz ao receber o evento
    for (;;) {
      if (events.some((e) => e.exportId === first.exportId && e.phase === 'done')) break
      await new Promise((r) => setImmediate(r))
    }
    const second = await exporter.start(request({ clipId: 'clip-2' }))
    await exporter.idle()
    const finals = events.filter((e) => e.phase === 'done' || e.phase === 'error')
    expect(finals.map((e) => [e.clipId, e.phase])).toEqual([['clip-1', 'done'], ['clip-2', 'done']])
    expect(second.exportId).not.toBe(first.exportId)
    expect(readdirSync(join(dir, 'exports', 'cortes')).filter((n) => n.endsWith('.mp4')).sort()).toEqual(['01 - Gravar a tela em segundos.mp4', '02 - Segundo corte.mp4'])
  })
})

describe('o texto do YouTube que acompanha o 16:9', () => {
  it('grava "<título> - YouTube.txt" ao lado do vídeo com 3 títulos, a descrição com capítulos no tempo de saída e as tags', async () => {
    const { dir, request, run } = await build((p) => {
      // os dois únicos cortes do projeto: 10 s no começo do trabalho e o fim todo (deixa o vídeo de 100 s e a exportação curta)
      p.cuts = [
        { id: 'c1', start: 20_000, end: 30_000, reason: 'manual', enabled: true },
        { id: 'c2', start: 110_000, end: LONG_MS, reason: 'manual', enabled: true }
      ]
      p.meta = {
        youtube: {
          titles: ['Como gravar a tela', 'Gravação de tela em minutos', 'Gravar tela sem complicação'],
          description: 'Mostro como gravar a tela.',
          tags: ['gravar tela', 'tutorial'],
          chapters: [{ start: 0, title: 'Introdução' }, { start: 40_000, title: 'Gravando' }, { start: 100_000, title: 'Fechamento' }]
        }
      }
    }, 'longo')
    const done = await run(request())
    expect(done.message ?? '').toBe('')
    expect(done.phase).toBe('done')
    expect(done.textPath).toBe(join(dir, 'exports', 'Projeto de 3 minutos - YouTube.txt'))
    const text = readFileSync(done.textPath!, 'utf8')
    expect(text).toBe(
      [
        'TÍTULOS (escolha um)',
        '1. Como gravar a tela',
        '2. Gravação de tela em minutos',
        '3. Gravar tela sem complicação',
        '',
        'DESCRIÇÃO',
        'Mostro como gravar a tela.',
        '',
        '00:00 Introdução',
        '00:30 Gravando', // 40 s de origem menos o corte de 10 s que vem antes
        '01:30 Fechamento', // 100 s de origem
        '',
        'TAGS',
        'gravar tela, tutorial',
        ''
      ].join('\n')
    )
    // a segunda exportação não sobrescreve
    const again = await run(request())
    expect(again.textPath).toBe(join(dir, 'exports', 'Projeto de 3 minutos - YouTube (2).txt'))
  })

  it('sem nada guardado na aba Publicar, os capítulos saem das pausas e o texto diz que foram gerados sem IA; o título é o do projeto', async () => {
    const { dir, request, run } = await build((p) => {
      p.cuts = [{ id: 'c1', start: 70_000, end: LONG_MS, reason: 'manual', enabled: true }] // vídeo de 70 s
    }, 'longo')
    const done = await run(request())
    expect(done.phase).toBe('done')
    const text = readFileSync(join(dir, 'exports', 'Projeto de 3 minutos - YouTube.txt'), 'utf8')
    expect(text).toContain('1. Projeto de 3 minutos')
    expect(text).toMatch(/00:00 Introdução\n\d\d:\d\d .+\n\d\d:\d\d .+/)
    expect(text).toContain('Capítulos gerados pelas pausas, sem IA: confira os títulos.')
  })

  it('vídeo curto demais para capítulos: o texto diz por quê (nunca uma lista inválida)', async () => {
    const { request, run } = await build()
    const done = await run(request())
    expect(done.phase).toBe('done')
    const text = readFileSync(done.textPath!, 'utf8')
    expect(text).toContain('Capítulos não incluídos: O vídeo tem 23 s: não cabem 3 capítulos de pelo menos 10 s.')
    expect(text).not.toMatch(/\d\d:\d\d /)
  })

  it('o vertical do vídeo inteiro não grava texto', async () => {
    const { dir, request, run } = await build()
    const done = await run(request({ format: 'vertical' }))
    expect(done.phase).toBe('done')
    expect(done.textPath).toBeUndefined()
    expect(readdirSync(join(dir, 'exports'))).toEqual(['Projeto de exemplo - Vertical.mp4'])
  })

  it('capítulos que não cumprem as regras do YouTube ficam fora do texto, com o motivo', async () => {
    const { request, run } = await build((p) => {
      p.meta = { youtube: { titles: ['T'], description: 'd', chapters: [{ start: 0, title: 'Só um' }, { start: 12_000, title: 'Dois' }] } }
    })
    const done = await run(request())
    const text = readFileSync(done.textPath!, 'utf8')
    expect(text).toContain('Capítulos não incluídos: o YouTube pede pelo menos 3 capítulos (há 2).')
    expect(text).not.toContain('00:12')
  })
})
