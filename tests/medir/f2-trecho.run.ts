import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { parseProject } from '@shared/project'
import { eventsFromText } from '@shared/events'
import { applyScreenCrop, deriveProject, evaluateScene, prepareEvents, projectLegibility } from '@shared/scene'
import { textPxOnFrame } from '@shared/legible'
import { ensureVertical, projectForFormat } from '@shared/vertical'
import { parseFaceTrack } from '@shared/face'

const ROOT = process.env.F2_PROJECTS ?? 'C:/tmp/tomada-f2-prova/projetos'
const V = { kind: 'vertical' as const, w: 1080, h: 1920 }
const G = process.env.F2_G ?? 'g1437'
const LAYOUT = (process.env.F2_LAYOUT ?? 'stack') as 'stack'
const FROM = Number(process.env.F2_FROM ?? 17000)
const TO = Number(process.env.F2_TO ?? 23000)
test('trecho', () => {
  const dir = `${ROOT}/${G}`
  const rd = (f: string): string | undefined => { try { return readFileSync(dir + '/' + f, 'utf8') } catch { return undefined } }
  const project = parseProject(rd('project.parsed.json')!)
  const words = JSON.parse(rd('transcript.json')!).words
  const events = eventsFromText({ cursor: rd('events/cursor.jsonl'), clicks: rd('events/clicks.jsonl'), keys: rd('events/keys.jsonl'), contentRect: rd('events/content-rect.jsonl'), contentMap: rd('events/content-map.jsonl') })
  const durationMs = Math.max(project.sources.screen?.durationMs ?? 0, project.sources.camera?.durationMs ?? 0)
  const data = prepareEvents(events, durationMs)
  const face = parseFaceTrack(rd('media/camera-face.json')!)
  const base = structuredClone(project)
  base.vertical = { ...(base.vertical ?? { layout: LAYOUT, layouts: [], zooms: [] }), layout: LAYOUT, layouts: [] }
  const ensured = ensureVertical(base, applyScreenCrop(data, base), { durationMs, words, hasCursorEvents: true, hasMatte: true })
  const p = projectForFormat({ ...ensured, vertical: { ...ensured.vertical!, layout: LAYOUT, layouts: [] } }, 'vertical')
  const d = deriveProject(p, data, V, words, face)
  const lg = d.legible[LAYOUT]
  console.log('keys', JSON.stringify(lg?.plan.keys.filter((k) => k.t0 >= FROM - 3000 && k.t0 <= TO).map((k) => [Math.round(k.t0), Math.round(k.t1 ?? 0), +k.to.zoom.toFixed(2), k.reason])))
  const line: string[] = []
  for (let t = FROM; t <= TO; t += 500) {
    const sc = evaluateScene(p, d, t, V).screen!
    line.push(`${(t / 1000).toFixed(1)}:${textPxOnFrame(d.body.textSrcPx, sc.dest.w, sc.src.w * d.screenSize!.w).toFixed(0)}`)
  }
  console.log(line.join(' '))
  console.log('issues', JSON.stringify(projectLegibility(p, d)))
})
