/**
 * F2, a parte que o usuário vê: o 9:16 com câmera nasce no Green screen (V-E), a prévia mostra o layout anterior enquanto o recorte do fundo
 * não existe (sem desenhar a câmera inteira por cima da página), o aviso de letra pequena tem resumo, e o nome "Apresentador recortado"
 * sumiu de tudo que se vê (agora é "Você sem fundo (green screen)").
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { processCursor, type CursorGrid } from '@shared/cursor'
import { legibilitySummary, type LegibilityIssue } from '@shared/legible'
import { matteFallbackLayout, withMatteFallback } from '@shared/matte-fallback'
import { createProject } from '@shared/project'
import { usesPresenter } from '@shared/scene'
import { ensureVertical, projectForFormat } from '@shared/vertical'
import type { ClickEvent, CursorSample, Project } from '@shared/types'
import { ROOT } from '../helpers/fs'

const D = 30_000
function doc(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p1',
    title: 'Teste',
    createdAt: '2026-10-12T12:00:00.000Z',
    sources: {
      screen: { path: 'media/screen.mp4', w: 1920, h: 912, fps: 30, durationMs: D },
      camera: { path: 'media/camera.mp4', w: 1280, h: 720, fps: 30, durationMs: D }
    }
  })
  return { ...p, ...over }
}
const grid = (): CursorGrid => {
  const samples: CursorSample[] = []
  for (let t = 0; t <= D; t += 8) samples.push({ t, x: 0.5, y: 0.5 })
  return processCursor(samples, [], { durationMs: D })
}
const click = (t: number): ClickEvent => ({ t, x: 0.5, y: 0.5, button: 'left' })
const data = { clicks: [click(5000), click(6500), click(20_000)], keys: [], grid: grid() }

describe('o 9:16 com câmera nasce no Green screen (V-E)', () => {
  it('com o recorte pronto: V-E no vídeo inteiro, sem trechos por atividade, com os zooms do vertical', () => {
    const next = ensureVertical(doc(), data, { durationMs: D, hasMatte: true })
    expect(next.vertical!.layout).toBe('greenscreen')
    expect(next.vertical!.layouts).toEqual([])
    expect(next.vertical!.zoomPreset).toBe('moderate')
    expect(next.vertical!.zooms.length).toBeGreaterThan(0)
    expect(projectForFormat(next, 'vertical').style.defaultLayout).toBe('greenscreen')
  })

  it('com o recorte esperado (motor pronto, ainda recortando): o mesmo, a prévia mostra o layout anterior até ele terminar', () => {
    const next = ensureVertical(doc(), data, { durationMs: D, matteExpected: true })
    expect(next.vertical!.layout).toBe('greenscreen')
    expect(next.vertical!.layouts).toEqual([])
  })

  it('sem o recorte e sem o motor: o comportamento de antes (Câmera + tela nos trechos sem atividade, padrão Tela ao centro)', () => {
    const next = ensureVertical(doc(), data, { durationMs: D })
    expect(next.vertical!.layout).toBe('screen-center')
  })

  it('sem câmera, ou com a câmera escondida, ou sem tela, não há Green screen', () => {
    const base = doc()
    const noCamera = ensureVertical({ ...base, sources: { ...base.sources, camera: undefined } }, data, { durationMs: D, hasMatte: true })
    expect(noCamera.vertical!.layout).toBe('screen-center')
    const hidden = ensureVertical({ ...base, style: { ...base.style, camera: { ...base.style.camera, hidden: true } } }, data, { durationMs: D, hasMatte: true })
    expect(hidden.vertical!.layout).toBe('screen-center')
    const noScreen = ensureVertical({ ...base, sources: { ...base.sources, screen: undefined } }, data, { durationMs: D, hasMatte: true })
    expect(noScreen.vertical!.layout).not.toBe('greenscreen')
  })

  it('só gera uma vez: o vertical que o usuário já mexeu não volta para o Green screen', () => {
    const manual = doc({ vertical: { layout: 'stack', layouts: [], zooms: [], zoomPreset: 'off' } })
    expect(ensureVertical(manual, data, { durationMs: D, hasMatte: true })).toBe(manual)
  })
})

describe('enquanto o recorte não existe, a prévia mostra o layout sem recorte', () => {
  it('cada layout com recorte tem o seu substituto: Câmera + tela no 9:16, lado a lado no 16:9; os outros ficam', () => {
    for (const l of ['greenscreen', 'greenscreen-corner', 'presenter'] as const) {
      expect(matteFallbackLayout(l, 'vertical')).toBe('stack')
      expect(matteFallbackLayout(l, 'horizontal')).toBe('side-by-side')
    }
    for (const l of ['stack', 'screen-center', 'screen-focus', 'screen-wide', 'camera', 'bubble', 'side-by-side', 'screen'] as const) {
      expect(matteFallbackLayout(l, 'vertical')).toBe(l)
      expect(matteFallbackLayout(l, 'horizontal')).toBe(l)
    }
  })

  it('troca o layout padrão e os trechos, e deixa de precisar do recorte; o documento do usuário não muda', () => {
    const chosen = doc({
      vertical: {
        layout: 'greenscreen',
        layouts: [
          { id: 'a', start: 1000, end: 4000, layout: 'greenscreen-corner', origin: 'manual' },
          { id: 'b', start: 6000, end: 9000, layout: 'screen-focus', origin: 'manual' }
        ],
        zooms: []
      }
    })
    const view = projectForFormat(chosen, 'vertical')
    expect(usesPresenter(view, 'vertical')).toBe(true)
    const shown = withMatteFallback(view, 'vertical')
    expect(shown.style.defaultLayout).toBe('stack')
    expect(shown.layouts.map((s) => s.layout)).toEqual(['stack', 'screen-focus'])
    expect(usesPresenter(shown, 'vertical')).toBe(false)
    // o que o usuário escolheu continua escolhido
    expect(view.style.defaultLayout).toBe('greenscreen')
    expect(view.layouts[0]!.layout).toBe('greenscreen-corner')
  })

  it('sem nada a trocar devolve o MESMO objeto (a prévia não recalcula à toa)', () => {
    const plain = projectForFormat(doc({ vertical: { layout: 'stack', layouts: [], zooms: [] } }), 'vertical')
    expect(withMatteFallback(plain, 'vertical')).toBe(plain)
    const h = doc()
    expect(withMatteFallback(h, 'horizontal')).toBe(h)
  })

  it('no 16:9 o Você sem fundo vira lado a lado enquanto não há recorte', () => {
    const h = doc({ style: { ...doc().style, defaultLayout: 'presenter' } })
    expect(withMatteFallback(h, 'horizontal').style.defaultLayout).toBe('side-by-side')
  })
})

describe('resumo do aviso de letra pequena', () => {
  const issue = (startMs: number, endMs: number, textPx: number, layout: LegibilityIssue['layout']): LegibilityIssue => ({ startMs, endMs, textPx, layout })
  it('sem aviso devolve null', () => {
    expect(legibilitySummary([])).toBeNull()
  })
  it('a menor letra arredondada, o tempo total e os layouts sem repetir', () => {
    const s = legibilitySummary([issue(0, 2000, 9.4, 'screen-wide'), issue(5000, 7500, 7.2, 'screen-wide'), issue(9000, 11_000, 18.6, 'stack')])
    expect(s).toEqual({ minPx: 7, totalMs: 6500, layouts: ['screen-wide', 'stack'] })
  })
})

describe('nomes que o usuário vê', () => {
  const dicionario = readdirSync(join(ROOT, 'src', 'renderer', 'i18n'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(ROOT, 'src', 'renderer', 'i18n', f), 'utf8'))
    .join('\n')
  it('"Apresentador recortado" não aparece mais em lugar nenhum da interface', () => {
    expect(dicionario).not.toMatch(/Apresentador recortado/)
    expect(dicionario).not.toMatch(/layout Apresentador/)
  })
  it('o estilo da câmera se chama "Você sem fundo (green screen)", e os dois V-E têm nome e dica', () => {
    expect(dicionario).toContain("presenter: 'Você sem fundo (green screen)'")
    expect(dicionario).toContain("greenscreen: 'Green screen'")
    expect(dicionario).toContain("'greenscreen-corner': 'Green screen no canto'")
    expect(dicionario).toMatch(/greenscreen:\s*\n\s*'Só no vertical/)
  })
})
