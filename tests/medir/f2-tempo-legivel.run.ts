/**
 * F2: quanto do vídeo (tempo de SAÍDA, só o que fica depois dos cortes) a letra do corpo passa em cada faixa, por layout do 9:16, medido pelo MESMO
 * caminho da exportação (`deriveProject` + `evaluateScene`). Lê as gravações de F2_PROJECTS (cópias de trabalho; nada do usuário entra no
 * repositório) e escreve F2_OUT_TEMPO (JSON). Rodar com o vitest.medir.config.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'vitest'
import { parseProject } from '@shared/project'
import { eventsFromText } from '@shared/events'
import { applyScreenCrop, deriveProject, evaluateScene, prepareEvents } from '@shared/scene'
import { textPxOnFrame } from '@shared/legible'
import { ensureVertical, projectForFormat } from '@shared/vertical'
import { parseFaceTrack } from '@shared/face'
import { keptRanges } from '@shared/timeline'

const ROOT = process.env.F2_PROJECTS ?? 'C:/tmp/tomada-f2-prova/projetos'
const OUT = process.env.F2_OUT_TEMPO ?? 'C:/tmp/tomada-f2-prova/tempo-legivel.json'
const V = { kind: 'vertical' as const, w: 1080, h: 1920 }
const LAYOUTS = ['greenscreen', 'greenscreen-corner', 'stack', 'screen-center'] as const
const STEP = 100

const result: Record<string, unknown> = {}
for (const g of ['g1004', 'g1437']) {
  test(`tempo legível ${g}`, () => {
    const dir = `${ROOT}/${g}`
    const rd = (f: string): string | undefined => {
      try {
        return readFileSync(dir + '/' + f, 'utf8')
      } catch {
        return undefined
      }
    }
    const project = parseProject(rd('project.json')!)
    const words = JSON.parse(rd('transcript.json')!).words
    const events = eventsFromText({ cursor: rd('events/cursor.jsonl'), clicks: rd('events/clicks.jsonl'), keys: rd('events/keys.jsonl'), contentRect: rd('events/content-rect.jsonl'), contentMap: rd('events/content-map.jsonl') })
    const durationMs = Math.max(project.sources.screen?.durationMs ?? 0, project.sources.camera?.durationMs ?? 0)
    const data = prepareEvents(events, durationMs)
    const face = parseFaceTrack(rd('media/camera-face.json')!)
    const per: Record<string, unknown> = {}
    for (const layout of LAYOUTS) {
      const base = structuredClone(project)
      base.vertical = { ...(base.vertical ?? { layout, layouts: [], zooms: [] }), layout, layouts: [] }
      const ensured = ensureVertical(base, applyScreenCrop(data, base), { durationMs, words, hasCursorEvents: true, hasMatte: true })
      const p = projectForFormat({ ...ensured, vertical: { ...ensured.vertical!, layout, layouts: [] } }, 'vertical')
      const d = deriveProject(p, data, V, words, face)
      let total = 0
      let below22 = 0
      let below28 = 0
      let above32 = 0
      let min = Infinity
      for (const r of keptRanges(durationMs, p.cuts)) {
        for (let t = r.start; t < r.end; t += STEP) {
          const sc = evaluateScene(p, d, t, V).screen
          if (!sc || !d.screenSize) continue
          const px = textPxOnFrame(d.body.textSrcPx, sc.dest.w, sc.src.w * d.screenSize.w)
          total += STEP
          if (px < 22) below22 += STEP
          if (px < 28) below28 += STEP
          if (px > 32) above32 += STEP
          min = Math.min(min, px)
        }
      }
      const lg = d.legible[layout]
      per[layout] = {
        totalSeconds: +(total / 1000).toFixed(1),
        pctBelow22: +((100 * below22) / Math.max(1, total)).toFixed(1),
        pctBelow28: +((100 * below28) / Math.max(1, total)).toFixed(1),
        pctAbove32: +((100 * above32) / Math.max(1, total)).toFixed(1),
        minPx: +min.toFixed(1),
        moves: lg?.plan.moves,
        overviews: lg?.plan.overviews
      }
    }
    result[g] = per
    writeFileSync(OUT, JSON.stringify(result, null, 1))
  })
}
