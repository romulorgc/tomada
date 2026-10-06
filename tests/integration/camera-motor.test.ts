/**
 * O motor da análise da câmera DE VERDADE (OpenCV + YuNet e o recorte do fundo RVM na placa, no venv do Python do app), com o código do app:
 *  - uma gravação REAL do usuário (`gravacoes/`, só nesta máquina; nada dela é copiado para `tests/`): só se prova que acha o rosto
 *    em quase toda a gravação, com caixas coerentes (nenhuma imagem é guardada nem impressa);
 *  - um vídeo SEM rosto (a câmera sintética dos fixtures), numa pasta com acento: devolve zero caixas sem erro;
 *  - progresso, cancelamento e os caminhos recusados;
 *  - o RECORTE DO FUNDO (M4c-B) num trecho da mesma gravação (a câmera real tem taxa VARIÁVEL: ~56 qps com a etiqueta de 60): o vídeo da
 *    máscara sai em cinza, num quadro por instante da câmera, com a pessoa clara e o fundo escuro, e cancelar devolve o motivo.
 * Exige o motor preparado (`npm run preparar:camera`, pela fila): sem ele o teste FALHA dizendo isso (nada de pular).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createPythonCamera } from '../../src/main/camera/python-engine'
import { locateFfmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { venvPython } from '../../src/main/transcription/faster-whisper'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import { FIX, useTmpDir } from '../helpers/env'
import { ROOT } from '../helpers/fs'

const tmp = useTmpDir()
const tools = toolPaths(ensureToolsDir())
const engine = createPythonCamera({ tools, scriptPath: join(ROOT, 'resources', 'camera_tools.py'), logger: createMemoryLogger(), ffmpeg: () => locateFfmpeg()?.ffmpeg ?? null })
const REAL = join(ROOT, 'gravacoes', '2026-07-26-13-57-59', 'camera.mp4')

beforeAll(async () => {
  const c = await engine.check()
  expect(c.face.state, `a análise da câmera não está preparada (${c.face.detail ?? 'sem detalhe'}). Rode: node scripts/fila-pesada.mjs npm run preparar:camera`).toBe('ready')
  expect(c.matte.state, `o recorte do fundo não está preparado (${c.matte.detail ?? 'sem detalhe'}). Rode: node scripts/fila-pesada.mjs npm run preparar:camera`).toBe('ready')
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

/** Lê um quadro do vídeo (cinza) como bytes crus, na proporção do próprio vídeo reduzida a 320 px de largura. */
function grayFrame(video: string, at: number): { w: number; h: number; px: Buffer } {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', video], { encoding: 'utf8' })) as { streams: { width: number; height: number }[] }
  const { width, height } = info.streams[0]!
  const w = 320
  const h = Math.round((height / width) * w)
  const px = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 })
  return { w, h, px }
}

const meanIn = (f: { w: number; h: number; px: Buffer }, x0: number, y0: number, x1: number, y1: number): number => {
  let sum = 0
  let n = 0
  for (let y = Math.floor(y0 * f.h); y < Math.ceil(y1 * f.h); y++) {
    for (let x = Math.floor(x0 * f.w); x < Math.ceil(x1 * f.w); x++) {
      sum += f.px[y * f.w + x]!
      n++
    }
  }
  return sum / n
}

/** Os instantes (s) dos quadros do vídeo, em ordem: dos pacotes (os instantes do arquivo, o que o leitor do render enxerga). */
function frameTimes(video: string): number[] {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', video], { encoding: 'utf8', maxBuffer: 1 << 24 })
  return out.trim().split(/\r?\n/).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
}

const probe = (video: string, entries: string): Record<string, string> => {
  const out = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', `stream=${entries}`, '-of', 'default=nw=1', video], { encoding: 'utf8' })
  return Object.fromEntries(out.trim().split(/\r?\n/).map((l) => l.split('=') as [string, string]))
}

describe('a grade de instantes da máscara (SlotWriter, no script do app)', () => {
  const run = (rate: number, start: number, frames: [number, string][]): string[] => {
    const code = [
      'import json, camera_tools as c',
      'out = []',
      `w = c.SlotWriter(out.append, ${rate}, ${start})`,
      `for t, p in ${JSON.stringify(frames)}: w.push(t, p)`,
      'w.finish()',
      'print(json.dumps(out))'
    ].join('\n')
    const stdout = execFileSync(venvPython(tools), ['-c', code], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: dirname(join(ROOT, 'resources', 'camera_tools.py')) } })
    return JSON.parse(stdout.trim().split(/\r?\n/).pop()!) as string[]
  }

  it('um quadro que falta na câmera repete o anterior (o render segura o quadro); a grade fica inteira', () => {
    expect(run(60, 0, [[0, 'a'], [0.0167, 'b'], [0.0333, 'c'], [0.0667, 'd'], [0.0834, 'e']])).toEqual(['a', 'b', 'c', 'c', 'd', 'e'])
  })

  it('dois quadros no mesmo instante: vale o último', () => {
    expect(run(60, 0, [[0, 'a'], [0.005, 'b'], [0.0167, 'c']])).toEqual(['b', 'c'])
  })

  it('a grade começa no início da câmera (deslocamento) e segura o quadro em buracos de vários instantes', () => {
    expect(run(30, 2, [[2, 'a'], [2.0333, 'b'], [2.1, 'c']])).toEqual(['a', 'b', 'b', 'c'])
  })
})

describe('recorte do fundo (RVM na placa) num trecho da gravação real', () => {
  it('sai um vídeo em cinza, na mesma taxa e com os mesmos quadros; a pessoa é clara, o fundo é escuro; o progresso sobe sem voltar', async () => {
    expect(existsSync(REAL), 'a gravação real do usuário fica em gravacoes/ (só nesta máquina, fora do git)').toBe(true)
    const dir = tmp()
    const excerpt = join(dir, 'camera-trecho.mp4')
    // 6 s do meio da gravação (o trecho fica numa pasta temporária e some ao fim; nada vai para tests/)
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '10', '-t', '6', '-i', REAL, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', excerpt])
    const out = join(dir, 'camera-matte.mp4')
    const progress: number[] = []
    const r = await engine.makeMatte({ video: excerpt, out, durationMs: 6000, onProgress: (f) => progress.push(f) })

    expect(existsSync(out)).toBe(true)
    expect(r.engine).toBe('rvm-resnet50')
    expect(r.frames).toBeGreaterThan(150)
    // a máscara tem o tamanho do vídeo (no máximo 1280 de lado maior) e a mesma proporção
    expect(Math.max(r.frame.w, r.frame.h)).toBeLessThanOrEqual(1280)
    expect(Math.abs(r.frame.w / r.frame.h - 16 / 9)).toBeLessThan(0.02)
    const src = probe(excerpt, 'r_frame_rate,avg_frame_rate,nb_read_frames,duration')
    const mat = probe(out, 'r_frame_rate,avg_frame_rate,nb_read_frames,duration,pix_fmt')
    // a máscara anda na GRADE da câmera (60/1), não na média dela (a webcam entrega ~56 qps): um quadro por instante
    expect(mat.r_frame_rate).toBe(src.r_frame_rate)
    expect(mat.pix_fmt).toBe('yuv420p')
    expect(Math.abs(Number(mat.duration) - Number(src.duration))).toBeLessThan(0.05)
    // cada quadro da câmera tem, no mesmo instante (meio quadro de tolerância), o quadro da máscara: nada de máscara atrasada
    const camT = frameTimes(excerpt)
    const matT = frameTimes(out)
    expect(matT.length).toBeGreaterThanOrEqual(camT.length)
    const half = 0.5 / 60 + 0.0005
    let worst = 0
    for (const p of camT) {
      let lo = 0
      let hi = matT.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (matT[mid]! < p) lo = mid + 1
        else hi = mid
      }
      const d = Math.min(Math.abs(matT[lo]! - p), lo > 0 ? Math.abs(matT[lo - 1]! - p) : Infinity)
      worst = Math.max(worst, d)
    }
    console.log(`instantes: ${camT.length} quadros da câmera (${src.avg_frame_rate} de média), ${matT.length} da máscara; pior diferença ${(worst * 1000).toFixed(1)} ms`)
    expect(worst).toBeLessThanOrEqual(half)

    // a pessoa (o centro-baixo do quadro, onde ela fica na gravação) é clara; o canto de cima, que é o quarto, é escuro
    const f = grayFrame(out, 3)
    const person = meanIn(f, 0.42, 0.55, 0.58, 0.95)
    const room = meanIn(f, 0.0, 0.0, 0.12, 0.35)
    console.log(`recorte real: pessoa ${person.toFixed(0)} · fundo ${room.toFixed(0)} · ${r.device} · ${r.msPerFrame.toFixed(1)} ms/quadro · ${r.frames} quadros`)
    expect(person).toBeGreaterThan(190)
    expect(room).toBeLessThan(40)

    expect(progress.length).toBeGreaterThan(0)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
    expect(Math.max(...progress)).toBe(1)
  })

  it('cancelar no meio interrompe o recorte com o motivo (quem descarta o arquivo parcial é o serviço, testado em camera-recorte)', async () => {
    const dir = tmp()
    const out = join(dir, 'camera-matte.mp4')
    const ctl = new AbortController()
    const run = engine.makeMatte({ video: REAL, out, durationMs: 28_672, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 2500)
    await expect(run).rejects.toThrow(/Cancelado/)
  })

  it('caminho que não é absoluto (ou que vira opção) é recusado antes de rodar qualquer coisa', async () => {
    const out = join(tmp(), 'm.mp4')
    await expect(engine.makeMatte({ video: 'media/camera.mp4', out, durationMs: 1000 })).rejects.toThrow(/Caminho inválido/)
    await expect(engine.makeMatte({ video: REAL, out: '-y', durationMs: 1000 })).rejects.toThrow(/Caminho inválido/)
  })

  it('vídeo que não existe: erro com o motivo (não um JSON quebrado)', async () => {
    await expect(engine.makeMatte({ video: join(tmp(), 'nao-existe.mp4'), out: join(tmp(), 'm.mp4'), durationMs: 1000 })).rejects.toThrow(/O recorte do fundo falhou/)
  })
})
