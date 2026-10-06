/**
 * Mudar o recorte da tela no documento (C1). Quando o recorte muda, o que a tela MOSTRA muda: os zooms automáticos (que nasceram
 * dos cliques) são refeitos a partir do que o novo recorte enxerga (clique numa aba deixa de abrir zoom), com os manuais intactos.
 * Código puro: sem DOM, sem Node.
 */
import { regenerateZooms } from './edits'
import { applyScreenCrop, type CursorData } from './scene'
import type { Project, ScreenCrop } from './types'
import { mergeFormatView, projectForFormat } from './vertical'
import { generateAutoZooms, zoomPresetFor } from './zoom'

/** Dois recortes pedem a mesma coisa? (para não regravar o documento à toa) */
export function sameScreenCrop(a: ScreenCrop | undefined, b: ScreenCrop | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * O documento com o recorte novo. `raw` são os eventos da tela inteira (sem recorte aplicado): com eles os zooms automáticos dos
 * dois formatos (os que têm preset escolhido; "Desligado" fica desligado) são refeitos sobre o recorte novo. Sem `raw` só troca o recorte.
 */
export function setScreenCrop(doc: Project, crop: ScreenCrop | undefined, raw: CursorData | null, durationMs: number): Project {
  if (sameScreenCrop(doc.screenCrop, crop)) return doc
  const next: Project = { ...doc }
  if (crop) next.screenCrop = crop
  else delete next.screenCrop
  if (!raw) return next
  const data = applyScreenCrop(raw, next)
  let out = next
  for (const kind of ['horizontal', 'vertical'] as const) {
    const view = projectForFormat(out, kind)
    const preset = view.zoomPreset
    if (preset === undefined || preset === 'off') continue
    const auto = generateAutoZooms({ clicks: data.clicks, keys: data.keys, cursor: data.grid, duration: durationMs, preset: zoomPresetFor(kind, preset) })
    out = mergeFormatView(out, regenerateZooms(view, preset, auto), kind)
  }
  return out
}

/** Muda só a moldura de navegador (a barra com o domínio): não mexe nos zooms. */
export function setBrowserFrame(doc: Project, frame: { enabled: boolean; domain?: string }): Project {
  const base: ScreenCrop = doc.screenCrop ?? { mode: 'off' }
  const same = (base.browserFrame?.enabled ?? false) === frame.enabled && (base.browserFrame?.domain ?? '') === (frame.domain ?? '')
  if (same) return doc
  const browserFrame = { enabled: frame.enabled, ...(frame.domain !== undefined && frame.domain !== '' ? { domain: frame.domain } : {}) }
  return { ...doc, screenCrop: { ...base, browserFrame } }
}
