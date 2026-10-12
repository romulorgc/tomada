/**
 * F2: escolhe 4 instantes de cada gravação (com fala, espalhados) e MEDE, nos quadros que o próprio caminho da exportação desenha, o
 * quanto a página foi ampliada e a letra que isso dá no vídeo vertical (px no quadro de 1080). Escreve o JSON que a prancha lê.
 * Lê as gravações de F2_PROJECTS (cópias de trabalho; nada do usuário entra no repositório). Rodar com o vitest.medir.config.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'vitest'
import { parseProject } from '@shared/project'
import { eventsFromText } from '@shared/events'
import { applyScreenCrop, deriveProject, evaluateScene, prepareEvents } from '@shared/scene'
import { textPxOnFrame } from '@shared/legible'
import { ensureVertical, projectForFormat } from '@shared/vertical'
import { parseFaceTrack } from '@shared/face'
import { sourceToOutput, keptRanges } from '@shared/timeline'

const ROOT = process.env.F2_PROJECTS ?? 'C:/tmp/tomada-f2-prova/projetos'
const OUT = process.env.F2_OUT ?? 'C:/tmp/tomada-f2-prova/prancha-instantes.json'
const V = { kind: 'vertical' as const, w: 1080, h: 1920 }
const LAYOUTS = ['greenscreen', 'greenscreen-corner', 'stack', 'screen-center'] as const

const result: Record<string, unknown> = {}
for (const g of ['g1004', 'g1437']) {
  test(`prancha ${g}`, () => {
    const dir = `${ROOT}/${g}`
    const rd = (f: string): string | undefined => {
      try {
        return readFileSync(dir + '/' + f, 'utf8')
      } catch {
        return undefined
      }
    }
    const project = parseProject(rd('project.parsed.json') ?? rd('project.json')!)
    const words = JSON.parse(rd('transcript.json')!).words as { start: number; end: number }[]
    const events = eventsFromText({ cursor: rd('events/cursor.jsonl'), clicks: rd('events/clicks.jsonl'), keys: rd('events/keys.jsonl'), contentRect: rd('events/content-rect.jsonl'), contentMap: rd('events/content-map.jsonl') })
    const durationMs = Math.max(project.sources.screen?.durationMs ?? 0, project.sources.camera?.durationMs ?? 0)
    const data = prepareEvents(events, durationMs)
    const face = parseFaceTrack(rd('media/camera-face.json')!)
    // 4 instantes com fala: o centro da palavra mais perto de 12%, 38%, 62% e 88% da gravação
    const times = [0.12, 0.38, 0.62, 0.88].map((f) => {
      const target = durationMs * f
      const w = words.reduce((best, x) => (Math.abs((x.start + x.end) / 2 - target) < Math.abs((best.start + best.end) / 2 - target) ? x : best), words[0]!)
      return Math.round((w.start + w.end) / 2)
    })
    const per: Record<string, unknown[]> = {}
    for (const layout of LAYOUTS) {
      const base = structuredClone(project)
      base.vertical = { ...(base.vertical ?? { layout, layouts: [], zooms: [] }), layout, layouts: [] }
      const ensured = ensureVertical(base, applyScreenCrop(data, base), { durationMs, words: words as never, hasCursorEvents: true, hasMatte: true })
      const p = projectForFormat({ ...ensured, vertical: { ...ensured.vertical!, layout, layouts: [] } }, 'vertical')
      const d = deriveProject(p, data, V, words as never, face)
      per[layout] = times.map((t) => {
        const scene = evaluateScene(p, d, t, V)
        const sc = scene.screen
        const srcW = sc && d.screenSize ? sc.src.w * d.screenSize.w : 0
        const textPx = sc ? textPxOnFrame(d.body.textSrcPx, sc.dest.w, srcW) : 0
        return {
          t,
          outputMs: Math.round(sourceToOutput(t, keptRanges(durationMs, p.cuts))),
          layout: scene.debug.layout,
          textPx: +textPx.toFixed(1),
          zoom: +(scene.debug.zoom.scale).toFixed(2),
          // a janela está fora do zoom de repouso (visão geral da troca de página ou rampa entre dois focos): letra menor de propósito
          moving: Math.abs(scene.debug.zoom.scale - (d.legible[layout]?.zoom ?? scene.debug.zoom.scale)) / (d.legible[layout]?.zoom ?? 1) > 0.06,
          pageWindowPx: Math.round(srcW),
          dest: sc ? { x: Math.round(sc.dest.x), y: Math.round(sc.dest.y), w: Math.round(sc.dest.w), h: Math.round(sc.dest.h) } : null,
          src: sc ? { x: +sc.src.x.toFixed(4), y: +sc.src.y.toFixed(4), w: +sc.src.w.toFixed(4), h: +sc.src.h.toFixed(4) } : null
        }
      })
    }
    result[g] = { times, native: { screen: project.sources.screen, textSrcPx: d0(per) }, layouts: per }
    writeFileSync(OUT, JSON.stringify(result, null, 1))
  })
}

function d0(_per: unknown): string {
  return 'estimativa do app: 13 px por 1080 de altura da tela gravada (ou Project.screenTextPx)'
}
