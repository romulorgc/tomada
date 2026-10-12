import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'vitest'
import { parseProject } from '@shared/project'
import { eventsFromText } from '@shared/events'
import { applyScreenCrop, deriveProject, evaluateScene, prepareEvents, projectLegibility } from '@shared/scene'
import { ensureVertical, projectForFormat } from '@shared/vertical'
import { parseFaceTrack } from '@shared/face'
import { contentDifference } from '@shared/punch-in'

const ROOT = process.env.F2_PROJECTS ?? 'C:/tmp/tomada-diag-1012/projetos'
const V = { kind: 'vertical' as const, w: 1080, h: 1920 }

for (const g of ['g1004', 'g1437']) {
  test(`calibra ${g}`, () => {
    const dir = `${ROOT}/${g}`
    const rd = (f: string): string | undefined => { try { return readFileSync(dir + '/' + f, 'utf8') } catch { return undefined } }
    const project = parseProject(rd('project.json')!)
    const words = JSON.parse(rd('transcript.json')!).words
    const events = eventsFromText({ cursor: rd('events/cursor.jsonl'), clicks: rd('events/clicks.jsonl'), keys: rd('events/keys.jsonl'), contentRect: rd('events/content-rect.jsonl'), contentMap: rd('events/content-map.jsonl') })
    const durationMs = Math.max(project.sources.screen?.durationMs ?? 0, project.sources.camera?.durationMs ?? 0)
    const data = prepareEvents(events, durationMs)
    const face = parseFaceTrack(rd('media/camera-face.json')!)
    // diferencas do mapa de conteudo
    const map = events.contentMap ?? []
    const diffs = map.slice(1).map((s, i) => ({ t: s.t, d: +contentDifference(map, map[i]!.t, s.t).toFixed(3) }))
    console.log(g, 'content-map diffs', JSON.stringify(diffs.filter((x) => x.d >= 0.03)))
    console.log(g, 'clicks', events.clicks.map((c) => Math.round(c.t)).join(','))
    const out: Record<string, unknown> = {}
    for (const layout of ['screen-center', 'stack', 'greenscreen', 'greenscreen-corner'] as const) {
      const base = structuredClone(project)
      base.vertical = { ...(base.vertical ?? { layout, layouts: [], zooms: [] }), layout, layouts: [] }
      const ensured = ensureVertical(base, applyScreenCrop(data, base), { durationMs, words, hasCursorEvents: true, hasMatte: true })
      const p = projectForFormat({ ...ensured, vertical: { ...ensured.vertical!, layout, layouts: [] } }, 'vertical')
      const d = deriveProject(p, data, V, words, face)
      const key = layout
      const lg = d.legible[key]
      console.log(g, layout, 'zoom', lg?.zoom.toFixed(2), 'textPx', lg?.targetPx.toFixed(1), 'moves', lg?.plan.moves, 'overviews', lg?.plan.overviews, 'keys', JSON.stringify(lg?.plan.keys.map((k) => [Math.round(k.t0), +k.to.cx.toFixed(2), +k.to.cy.toFixed(2), +k.to.zoom.toFixed(2), k.reason])))
      console.log(g, layout, 'issues', JSON.stringify(projectLegibility(p, d)))
      if (d.cornerPlan) console.log(g, layout, 'corner', JSON.stringify(d.cornerPlan))
      out[layout] = { zoom: lg?.zoom, textPx: lg?.targetPx }
    }
    writeFileSync(`C:/tmp/tomada-f2-prova/calibra-${g}.json`, JSON.stringify(out, null, 1))
  })
}
