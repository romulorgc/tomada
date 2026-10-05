/**
 * O motor da análise da câmera DE VERDADE (OpenCV + YuNet, no venv do Python do app), com o código do app:
 *  - uma gravação REAL do usuário (`gravacoes/`, só nesta máquina; nada dela é copiado para `tests/`): só se prova que acha o rosto
 *    em quase toda a gravação, com caixas coerentes (nenhuma imagem é guardada nem impressa);
 *  - um vídeo SEM rosto (a câmera sintética dos fixtures), numa pasta com acento: devolve zero caixas sem erro;
 *  - progresso, cancelamento e os caminhos recusados.
 * Exige o motor preparado (`npm run preparar:camera`, pela fila): sem ele o teste FALHA dizendo isso (nada de pular).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createPythonCamera } from '../../src/main/camera/python-engine'
import { createMemoryLogger } from '../../src/main/logger'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import { FIX, useTmpDir } from '../helpers/env'
import { ROOT } from '../helpers/fs'

const tmp = useTmpDir()
const tools = toolPaths(ensureToolsDir())
const engine = createPythonCamera({ tools, scriptPath: join(ROOT, 'resources', 'camera_tools.py'), logger: createMemoryLogger() })
const REAL = join(ROOT, 'gravacoes', '2026-07-26-13-57-59', 'camera.mp4')

beforeAll(async () => {
  const c = await engine.check()
  expect(c.face.state, `a análise da câmera não está preparada (${c.face.detail ?? 'sem detalhe'}). Rode: node scripts/fila-pesada.mjs npm run preparar:camera`).toBe('ready')
})

describe('motor da câmera (YuNet) na gravação real do usuário', () => {
  it('acha o rosto em quase toda a gravação, com caixas coerentes, e o progresso sobe de 0 a 1', async () => {
    expect(existsSync(REAL), 'a gravação real do usuário fica em gravacoes/ (só nesta máquina, fora do git)').toBe(true)
    const progress: number[] = []
    const started = performance.now()
    const track = await engine.detectFaces({ video: REAL, durationMs: 28_672, onProgress: (f) => progress.push(f) })
    const seconds = (performance.now() - started) / 1000

    expect(track.engine).toBe('yunet')
    expect(track.frame).toEqual({ w: 1920, h: 1080 })
    expect(track.sampleMs).toBe(200)
    expect(track.durationMs).toBeGreaterThan(28_000)
    expect(track.boxes.length).toBeGreaterThan(100)
    // cobertura: quase todo olhar do detector achou o rosto (a pessoa está de frente para a câmera)
    const looks = track.durationMs / track.sampleMs
    expect(track.boxes.length / looks).toBeGreaterThan(0.9)
    let prev = -1
    for (const b of track.boxes) {
      expect(b.t).toBeGreaterThan(prev)
      prev = b.t
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.x + b.w).toBeLessThanOrEqual(1.0001)
      expect(b.y + b.h).toBeLessThanOrEqual(1.0001)
      expect(b.h).toBeGreaterThan(0.1) // um rosto de verdade, não um ruído
      expect(b.h).toBeLessThan(0.95)
      expect(b.score).toBeGreaterThanOrEqual(0.6)
    }
    // o rosto não "pula" entre quadros vizinhos (olhares de 200 ms): a mediana do passo é pequena
    const steps = track.boxes.slice(1).map((b, i) => Math.abs(b.x + b.w / 2 - (track.boxes[i]!.x + track.boxes[i]!.w / 2)))
    steps.sort((a, b) => a - b)
    expect(steps[Math.floor(steps.length / 2)]!).toBeLessThan(0.03)
    expect(progress.length).toBeGreaterThan(0)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
    expect(Math.max(...progress)).toBe(1)
    // 28 s de vídeo analisados com folga (não é um teste de velocidade: o limite só pega um travamento)
    expect(seconds).toBeLessThan(90)
    console.log(`YuNet na gravação real: ${track.boxes.length} rostos em ${looks.toFixed(0)} olhares, ${seconds.toFixed(1)} s`)
  })

  it('vídeo sem rosto, numa pasta com acento: zero caixas e nenhum erro', async () => {
    const dir = join(tmp(), 'Gravação José ô')
    mkdirSync(dir, { recursive: true })
    const copy = join(dir, 'câmera.webm')
    copyFileSync(FIX.camera, copy)
    const track = await engine.detectFaces({ video: copy, durationMs: 6000 })
    expect(track.boxes).toEqual([])
    expect(track.frame.w).toBeGreaterThan(0)
  })

  it('cancelar no meio interrompe a análise com o motivo', async () => {
    const ctl = new AbortController()
    const run = engine.detectFaces({ video: REAL, durationMs: 28_672, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 400)
    await expect(run).rejects.toThrow(/Cancelado/)
  })

  it('caminho que não é absoluto (ou que vira opção) é recusado antes de rodar qualquer coisa', async () => {
    await expect(engine.detectFaces({ video: 'media/camera.mp4', durationMs: 1000 })).rejects.toThrow(/Caminho do vídeo inválido/)
    await expect(engine.detectFaces({ video: '-i', durationMs: 1000 })).rejects.toThrow(/Caminho do vídeo inválido/)
  })

  it('vídeo que não existe: erro com o motivo (não um JSON quebrado)', async () => {
    await expect(engine.detectFaces({ video: join(tmp(), 'nao-existe.mp4'), durationMs: 1000 })).rejects.toThrow(/A análise do rosto falhou/)
  })
})
