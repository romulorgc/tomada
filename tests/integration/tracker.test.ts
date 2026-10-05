/**
 * O rastreador de VERDADE: worker_thread + koffi lendo o cursor real desta máquina. Só LÊ
 * (não mexe no mouse); os testes que clicam estão em `npm run test:real`.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../../src/main/logger'
import { createTracker } from '../../src/main/tracker'
import { loadWin32, TYPING_VKS } from '../../src/main/win32'
import { ROOT } from '../helpers/fs'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let workerPath = ''

beforeAll(async () => {
  // O worker é TypeScript com import de koffi: compila para CommonJS dentro do repositório
  // (assim o `require('koffi')` acha node_modules).
  const outdir = join(ROOT, '.cache', 'test-worker')
  mkdirSync(outdir, { recursive: true })
  workerPath = join(outdir, 'tracker-worker.cjs')
  await build({
    entryPoints: [join(ROOT, 'src', 'main', 'tracker-worker.ts')],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['koffi'],
    logLevel: 'silent'
  })
  loadWin32().ensureDpiAware() // pixels físicos, como no app (o Electron já é "aware")
})

describe('win32 (koffi)', () => {
  it('lê o cursor em pixels físicos e lista os monitores com um principal', () => {
    const w = loadWin32()
    const p = w.getCursorPos()
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    const monitors = w.monitors()
    expect(monitors.length).toBeGreaterThanOrEqual(1)
    expect(monitors.filter((m) => m.primary)).toHaveLength(1)
    const primary = monitors.find((m) => m.primary)!
    expect(primary.rect.x).toBe(0) // o monitor principal contém a origem
    expect(primary.rect.y).toBe(0)
    for (const m of monitors) {
      expect(m.rect.w).toBeGreaterThan(0)
      expect(m.rect.h).toBeGreaterThan(0)
    }
    // O cursor está dentro da área virtual.
    const v = w.virtualScreen()
    expect(p.x).toBeGreaterThanOrEqual(v.x)
    expect(p.x).toBeLessThan(v.x + v.w)
  })

  it('a lista de teclas "de digitação" não inclui mouse nem modificadores (Ctrl+Shift+R não é digitação)', () => {
    for (const mouse of [0x01, 0x02, 0x04]) expect(TYPING_VKS).not.toContain(mouse)
    for (const mod of [0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c, 0x14]) expect(TYPING_VKS).not.toContain(mod)
    expect(TYPING_VKS).toContain(0x41) // A
    expect(TYPING_VKS).toContain(0x20) // espaço
    expect(TYPING_VKS).toContain(0x0d) // Enter
  })
})

describe('rastreador a 120 Hz (worker_thread)', () => {
  it('amostra ~120 vezes por segundo, em ordem, na posição real do cursor, e para quando mandado', async () => {
    const w = loadWin32()
    const logger = createMemoryLogger()
    const tracker = createTracker({ kind: 'screen', hwnd: null }, { workerPath, logger })
    const before = w.getCursorPos()
    await tracker.start()
    expect(tracker.running).toBe(true)
    await sleep(3000)
    const result = await tracker.stop()
    const after = w.getCursorPos()

    expect(result.error).toBeNull()
    expect(tracker.running).toBe(false)
    const n = result.raw.cursor.length / 3
    const seconds = result.stats!.seconds
    const perSecond = n / seconds
    expect(seconds).toBeGreaterThan(2.7)
    expect(perSecond, `taxa medida ${perSecond.toFixed(1)} Hz (intervalo mediano ${result.stats!.intervalMedianMs.toFixed(2)} ms)`).toBeGreaterThan(110)
    expect(perSecond).toBeLessThan(130)
    expect(result.stats!.hz).toBeGreaterThan(110)
    expect(result.stats!.intervalP95Ms).toBeLessThan(14) // sem oscilar (setInterval de 8 ms ficaria em ~15,6)
    expect(result.stats!.intervalMedianMs).toBeGreaterThan(7)
    expect(result.stats!.intervalMedianMs).toBeLessThan(9.5)

    // Tempos estritamente crescentes, em milissegundos de relógio de parede.
    let last = -Infinity
    for (let i = 0; i < result.raw.cursor.length; i += 3) {
      const t = result.raw.cursor[i]!
      expect(t).toBeGreaterThan(last)
      last = t
    }
    expect(Math.abs(result.raw.cursor[0]! - (performance.timeOrigin + performance.now()))).toBeLessThan(10_000)

    // Sem mexer no mouse, toda amostra é a posição lida por fora (antes e depois).
    const moved = before.x !== after.x || before.y !== after.y
    if (!moved) {
      for (let i = 1; i < result.raw.cursor.length; i += 3) {
        expect(result.raw.cursor[i]).toBe(before.x)
        expect(result.raw.cursor[i + 1]).toBe(before.y)
      }
    }
    // Nenhum clique, nenhuma tecla (ninguém usou o mouse/teclado de propósito; só o formato importa).
    for (const k of result.raw.keys) expect(typeof k).toBe('number')
    for (const c of result.raw.clicks) expect(Object.keys(c).sort()).toEqual(['button', 't', 'upT', 'x', 'y'].filter((key) => key in c).sort())
  })

  it('pausa: nada é amostrado enquanto pausado; ao retomar volta ao ritmo', async () => {
    const tracker = createTracker({ kind: 'screen', hwnd: null }, { workerPath, logger: createMemoryLogger() })
    await tracker.start()
    await sleep(700)
    tracker.pause()
    const pausedAt = performance.timeOrigin + performance.now()
    await sleep(900)
    const resumedAt = performance.timeOrigin + performance.now()
    tracker.resume()
    await sleep(700)
    const result = await tracker.stop()
    const times: number[] = []
    for (let i = 0; i < result.raw.cursor.length; i += 3) times.push(result.raw.cursor[i]!)
    // Margem de 40 ms nas duas pontas (o worker só olha o sinalizador a cada tique).
    const inside = times.filter((t) => t > pausedAt + 40 && t < resumedAt - 40)
    expect(inside).toHaveLength(0)
    const before = times.filter((t) => t <= pausedAt + 40).length
    const afterCount = times.filter((t) => t >= resumedAt - 40).length
    expect(before).toBeGreaterThan(60)
    expect(afterCount).toBeGreaterThan(60)
  })

  it('janela que não existe: avisa (window-gone) em ~300 ms e a gravação segue', async () => {
    let gone = 0
    const tracker = createTracker(
      { kind: 'window', hwnd: 0x7ffffff0 },
      { workerPath, logger: createMemoryLogger(), onWindowGone: () => void gone++ }
    )
    await tracker.start()
    await sleep(900)
    const result = await tracker.stop()
    expect(gone).toBe(1)
    expect(result.windowGone).toBe(true)
    expect(result.raw.cursor.length).toBeGreaterThan(50) // o cursor continua sendo amostrado
    expect(result.raw.windowRects).toEqual([])
  })

  it('worker que não sobe devolve erro claro em vez de travar', async () => {
    const tracker = createTracker({ kind: 'screen', hwnd: null }, { workerPath: join(ROOT, '.cache', 'nao-existe.cjs'), logger: createMemoryLogger() })
    await expect(tracker.start()).rejects.toThrow(/rastreador/i)
  })
})
