/**
 * Acabamento C: a janela quadrada do 9:16 enquadra a AÇÃO (clique, digitação, cursor parado), com permanência mínima e transição
 * suave, sem ampliar além de 1:1 e sem cortar a coluna de conteúdo onde a ação está. O V-A continua seguindo o cursor.
 */
import { describe, expect, it } from 'vitest'
import {
  FOCUS_LEAD_MS,
  FOCUS_MIN_HOLD_MS,
  FOCUS_SAFE,
  FOCUS_SPRING,
  actionFocusAt,
  buildActionFocus,
  focusPoints
} from '@shared/action-focus'
import { processCursor } from '@shared/cursor'
import { createProject } from '@shared/project'
import { VERTICAL_1080, deriveProject, evaluateScene, prepareEvents } from '@shared/scene'
import type { ClickEvent, CursorSample, LayoutKind, Project } from '@shared/types'
import { projectForFormat } from '@shared/vertical'
import { computeCameraPath, sampleCameraPath } from '@shared/zoom'

/** Uma página 1920×1000 (webmail): janela quadrada de 1000 px = 52% da largura. */
const W = 1920, H = 1000
const VIEW = { w: H / W, h: 1 }
const click = (t: number, x: number, y: number): ClickEvent => ({ t, x: x / W, y: y / H, button: 'left', upT: t + 80 })
const still = (x: number, y: number, ms = 12_000): CursorSample[] => Array.from({ length: Math.floor(ms / 50) + 1 }, (_, i) => ({ t: i * 50, x: x / W, y: y / H }))
const grid = (samples: CursorSample[], durationMs = 12_000) => processCursor(samples, [], { durationMs })

describe('pontos de ação', () => {
  it('cliques dentro da página, a digitação onde foi o último clique e o cursor parado', () => {
    const samples: CursorSample[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ t: i * 50, x: (200 + i * 60) / W, y: 500 / H })), // anda até x≈1340
      ...Array.from({ length: 40 }, (_, i) => ({ t: 1000 + i * 50, x: 1500 / W, y: 300 / H })) // fica parado ~2 s
    ]
    const clicks = [click(500, 700, 400), { ...click(900, 100, 20), out: true }]
    const keys = [{ t: 4000 }, { t: 4100 }, { t: 4200 }, { t: 4300 }]
    const points = focusPoints({ clicks, keys, cursor: grid(samples, 3000) })
    expect(points.some((p) => p.t === 500 && Math.abs(p.x - 700 / W) < 1e-9)).toBe(true)
    expect(points.some((p) => Math.abs(p.t - 900) < 1 && p.x < 100 / W + 1e-9)).toBe(false) // clique fora da página não é ação
    expect(points.find((p) => p.t === 4000)).toMatchObject({ x: 700 / W, y: 400 / H }) // digitação: onde foi o último clique (3,5 s antes)
    expect(points.some((p) => p.t >= 1000 && p.t <= 1100 && Math.abs(p.x - 1500 / W) < 0.01)).toBe(true) // cursor parado
  })
})

describe('enquadramento da ação', () => {
  it('o vídeo já começa enquadrado na primeira ação', () => {
    const steps = buildActionFocus({ clicks: [click(1000, 1500, 500)], keys: [], cursor: grid(still(960, 500)), view: VIEW })!
    expect(steps[0]!.t).toBe(0)
    expect(steps[0]!.cx).toBeCloseTo(1500 / W - 0.001, 1)
    expect(Math.abs(steps[0]!.cx - 1500 / W)).toBeLessThanOrEqual((VIEW.w / 2) * FOCUS_SAFE + 1e-9)
  })

  it('ação que já está enquadrada não move a janela, mesmo com o cursor passeando pela tela', () => {
    const clicks = [click(1000, 900, 400), click(3000, 1000, 520), click(5000, 1050, 600), click(7000, 950, 700)]
    const wandering: CursorSample[] = Array.from({ length: 241 }, (_, i) => ({ t: i * 50, x: (0.15 + 0.7 * Math.abs(Math.sin(i / 20))), y: 0.5 }))
    const steps = buildActionFocus({ clicks, keys: [], cursor: grid(wandering), view: VIEW })!
    expect(steps).toHaveLength(1)
  })

  it('ação fora da faixa central: a janela vai até ela, começando um pouco antes', () => {
    const clicks = [click(1000, 500, 500), click(5000, 1500, 500)]
    const steps = buildActionFocus({ clicks, keys: [], cursor: grid(still(500, 500)), view: VIEW })!
    expect(steps).toHaveLength(2)
    expect(steps[1]!.t).toBe(5000 - FOCUS_LEAD_MS)
    expect(Math.abs(steps[1]!.cx - 1500 / W)).toBeLessThanOrEqual((VIEW.w / 2) * FOCUS_SAFE + 1e-9)
  })

  it('permanência mínima: duas ações distantes em sequência rápida não fazem a janela correr de um lado a outro', () => {
    const clicks = [click(1000, 300, 500), click(3000, 1600, 500), click(3400, 300, 500), click(3800, 1600, 500)]
    const steps = buildActionFocus({ clicks, keys: [], cursor: grid(still(300, 500)), view: VIEW })!
    for (let i = 2; i < steps.length; i++) expect(steps[i]!.t - steps[i - 1]!.t).toBeGreaterThanOrEqual(FOCUS_MIN_HOLD_MS)
  })

  it('a coluna onde se clicou várias vezes não é cortada: a janela fica onde cabem todas as ações recentes', () => {
    // coluna de texto de 560 a 1360 (800 px); janela de 1000 px; cliques de um lado a outro da coluna e depois no botão, à esquerda
    const clicks = [click(1000, 700, 330), click(2500, 1250, 470), click(4000, 600, 800)]
    const steps = buildActionFocus({ clicks, keys: [], cursor: grid(still(700, 330)), view: VIEW })!
    const at = (t: number) => actionFocusAt(steps, t).cx * W
    for (const t of [1200, 2900, 4500]) {
      expect(at(t) - 500, `janela cobre a coluna em t=${t}`).toBeLessThanOrEqual(560 + 1e-6) // borda esquerda da janela ≤ 560
      expect(at(t) + 500, `janela cobre a coluna em t=${t}`).toBeGreaterThanOrEqual(1360 - 1e-6) // borda direita da janela ≥ 1360
    }
  })

  it('movimento pequeno demais não move a janela', () => {
    const clicks = [click(1000, 960, 500), click(3000, 960 + 0.35 * 1000 * 0.7 * 0.5 + 6, 500)] // cai logo fora da faixa central, a 6 px
    const steps = buildActionFocus({ clicks, keys: [], cursor: grid(still(960, 500)), view: VIEW })!
    expect(steps.length).toBeLessThanOrEqual(2)
    if (steps.length === 2) expect(Math.abs(steps[1]!.cx - steps[0]!.cx)).toBeGreaterThanOrEqual(0.06 * VIEW.w)
  })

  it('sem nenhuma ação (só passeio do cursor) não há o que enquadrar: devolve null e a janela segue o cursor', () => {
    const drift: CursorSample[] = Array.from({ length: 121 }, (_, i) => ({ t: i * 50, x: (200 + i * 12) / W, y: 500 / H }))
    expect(buildActionFocus({ clicks: [], keys: [], cursor: grid(drift, 6000), view: VIEW })).toBeNull()
  })
})

describe('caminho da câmera com o foco da ação', () => {
  const clicks = [click(1000, 500, 500), click(5000, 1500, 500)]
  const cursor = grid(Array.from({ length: 241 }, (_, i) => ({ t: i * 50, x: (0.1 + 0.8 * Math.abs(Math.sin(i / 17))), y: 0.5 })))
  const steps = buildActionFocus({ clicks, keys: [], cursor, view: VIEW })!
  const path = computeCameraPath({ zooms: [] }, cursor, { durationMs: 12_000, view: VIEW, focusAt: (t) => actionFocusAt(steps, t), spring: FOCUS_SPRING })

  it('não segue o cursor errante: entre as ações o centro não anda', () => {
    const a = sampleCameraPath(path, 2000).cx, b = sampleCameraPath(path, 4000).cx
    expect(Math.abs(a - b)).toBeLessThan(0.002)
  })

  it('vai até a ação seguinte com transição suave (sem salto) e chega a tempo', () => {
    let maxStep = 0
    for (let t = 3000; t < 7000; t += 16) maxStep = Math.max(maxStep, Math.abs(sampleCameraPath(path, t + 16).cx - sampleCameraPath(path, t).cx))
    expect(maxStep).toBeLessThan(0.02) // menos de 38 px de fonte por 16 ms: sem salto
    expect(Math.abs(sampleCameraPath(path, 6500).cx - (1500 - 0) / W)).toBeLessThanOrEqual((VIEW.w / 2) * FOCUS_SAFE + 0.01)
  })
})

describe('Tela ao centro e V-B: ampliação máxima 1:1 e foco da ação; V-A segue o cursor', () => {
  const screen = { path: 'media/screen.mp4', w: W, h: H, fps: 30, durationMs: 12_000 }
  const camera = { path: 'media/camera.mp4', w: 3840, h: 2160, fps: 30, durationMs: 12_000 }
  const mk = (layout: LayoutKind): Project => {
    const p = createProject({ title: 'Webmail', sources: { screen, camera } })
    p.zoomPreset = 'off'
    p.style.defaultLayout = layout
    p.vertical = { layout, layouts: [], zooms: [{ id: 'z1', start: 900, end: 2300, scale: 1.6, focus: 'auto', origin: 'auto' }, { id: 'z2', start: 4900, end: 6300, scale: 1.6, focus: 'auto', origin: 'auto' }], zoomPreset: 'moderate' }
    return p
  }
  const wander: CursorSample[] = Array.from({ length: 241 }, (_, i) => ({ t: i * 50, x: 0.2 + 0.6 * Math.abs(Math.sin(i / 17)), y: 0.5 }))
  const data = prepareEvents({ cursor: wander, clicks: [click(1000, 700, 330), click(5000, 1500, 500)], keys: [] }, 12_000)

  it.each(['screen-center', 'stack'] as const)('%s: o texto nunca é ampliado além de 1:1', (layout) => {
    const p = projectForFormat(mk(layout), 'vertical')
    const derived = deriveProject(p, data, VERTICAL_1080)
    let peak = 0
    for (let t = 0; t < 12_000; t += 50) {
      const s = evaluateScene(p, derived, t, VERTICAL_1080).screen!
      peak = Math.max(peak, s.dest.w / (s.src.w * W))
    }
    expect(peak).toBeLessThanOrEqual(1.001)
  })

  it('Tela ao centro: a janela não segue o cursor errante, fica na ação', () => {
    const p = projectForFormat(mk('screen-center'), 'vertical')
    const derived = deriveProject(p, data, VERTICAL_1080)
    const left = (t: number) => evaluateScene(p, derived, t, VERTICAL_1080).screen!.src.x
    // depois do zoom do primeiro clique (que termina em 2,3 s) e até o segundo, o cursor passeia por quase toda a largura e a janela fica quieta
    for (let at = 3200; at < 4400; at += 100) expect(Math.abs(left(at + 100) - left(at))).toBeLessThan(0.0005)
    expect(Math.abs(left(3200) - left(4400))).toBeLessThan(0.003)
  })

  it('V-A continua seguindo o cursor (escolha manual preservada)', () => {
    const p = projectForFormat(mk('screen-focus'), 'vertical')
    const derived = deriveProject(p, data, VERTICAL_1080)
    const left = (t: number) => evaluateScene(p, derived, t, VERTICAL_1080).screen!.src.x
    let travel = 0
    for (let t = 2600; t < 4400; t += 50) travel += Math.abs(left(t + 50) - left(t))
    expect(travel).toBeGreaterThan(0.05)
  })
})
