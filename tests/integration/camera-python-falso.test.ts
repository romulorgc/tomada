/**
 * O motor da câmera em Python (`createPythonCamera`) com um INTERPRETADOR FALSO (uma cópia do próprio Node no lugar do `python.exe` do
 * venv e um script de teste no lugar do `camera_tools.py`): prova o que o app faz AO REDOR do Python, sem instalar nada:
 *  - o estado do recorte do fundo (`check`): sem preparo, sem o modelo, com a placa, sem a placa (aviso do processador);
 *  - o pedido que vai ao script pelo stdin (o modelo, o ffmpeg do app, o lado maior, o caminho de saída);
 *  - o progresso vindo do stderr, o resultado, o erro do script com o motivo à vista e a recusa de caminhos suspeitos.
 * O motor DE VERDADE (RVM na placa) é provado em `camera-motor.test.ts`, que roda pela fila pesada.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createPythonCamera, MATTE_MODEL, YUNET_FILE, cameraModelDir } from '../../src/main/camera/python-engine'
import { MatteJoinError } from '../../src/main/camera/matte-join'
import { locateFfmpeg } from '../../src/main/ffmpeg'
import { createMemoryLogger } from '../../src/main/logger'
import { toolPaths, type ToolPaths } from '../../src/main/transcription/tools-dir'
import { useTmpDir } from '../helpers/env'
import { probeJson } from '../helpers/media'

const tmp = useTmpDir()

/** O que o script falso responde: lido do arquivo `modo.txt` ao lado dele (ok | erro | lixo | vazio). */
const FAKE_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const mode = fs.readFileSync(path.join(__dirname, 'modo.txt'), 'utf8').trim()
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(__dirname, 'pedido.json'), input)
  const req = JSON.parse(input)
  process.stderr.write('PROGRESS 0.25\\nPROGRESS 0.5\\nPROGRESS 1.0\\n')
  if (mode === 'erro') {
    process.stderr.write('ERRO: o onnxruntime não abriu a placa\\n')
    process.exit(3)
  }
  if (mode === 'lixo') return process.stdout.write('isto não é json')
  if (mode === 'vazio') return process.stdout.write(JSON.stringify({ frames: 0, fps: 30, frame: { w: 640, h: 360 } }))
  if (req.parts) {
    // EM PEDAÇOS: de verdade (ffmpeg), um mp4 de 2 s (60 quadros) por pedaço, o último com 20; no modo pedacos-parou entrega um e para
    const cp = require('node:child_process')
    const total = Number(fs.readFileSync(path.join(__dirname, 'total.txt'), 'utf8'))
    const made = []
    for (let i = req.parts.startChunk; i < total; i++) {
      const frames = i === total - 1 ? 20 : 60
      const file = path.join(req.parts.dir, 'p' + String(i).padStart(4, '0') + '.mp4')
      fs.mkdirSync(req.parts.dir, { recursive: true })
      cp.execFileSync(req.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=30', '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0', '-f', 'mp4', file])
      process.stderr.write('CHUNK ' + i + ' ' + frames + ' ' + fs.statSync(file).size + '\\n')
      made.push({ index: i, frames })
      if (mode === 'pedacos-parou') break
    }
    const last = mode === 'pedacos-buraco' ? total + 2 : total - 1
    return process.stdout.write(JSON.stringify({ engine: 'rvm', device: 'cuda', frames: 0, fps: 30, frame: { w: 160, h: 90 }, chunks: made, lastChunk: last, stopped: mode === 'pedacos-parou', resume: req.parts.startChunk > 0 ? 'checkpoint' : null, stats: { seconds: 1, msPerFrame: 10 } }))
  }
  fs.writeFileSync(req.out, 'máscara')
  process.stdout.write(JSON.stringify({ engine: 'rvm', device: 'cuda', frames: 90, fps: 30, frame: { w: 640, h: 360 }, stats: { seconds: 3, msPerFrame: 33.3 } }))
})
`

type Setup = { tools: ToolPaths; script: string; modo: (m: string) => void; total: (n: number) => void; pedido: () => { mode: string; video: string; out: string; model: string; ffmpeg: string; maxSide: number; crf: number } }

/** Um arquivo do tamanho certo sem escrever os bytes (o modelo do recorte tem 107 MB). */
function sparse(path: string, size: number): void {
  writeFileSync(path, '')
  truncateSync(path, size)
}

function cloneNode(dest: string): void {
  mkdirSync(join(dest, '..'), { recursive: true })
  try {
    linkSync(process.execPath, dest)
  } catch {
    copyFileSync(process.execPath, dest)
  }
}

function setup(opts: { providers?: string[]; gpu?: string | null; matteModel?: boolean; onnx?: boolean } = {}): Setup {
  const base = tmp()
  const tools = toolPaths(base)
  const { providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'], gpu = 'NVIDIA GeForce RTX 3050 Laptop GPU', matteModel = true, onnx = true } = opts
  cloneNode(join(tools.venv, 'Scripts', 'python.exe'))
  mkdirSync(cameraModelDir(tools), { recursive: true })
  mkdirSync(tools.state, { recursive: true })
  sparse(join(cameraModelDir(tools), YUNET_FILE.name), YUNET_FILE.size)
  if (matteModel) sparse(join(cameraModelDir(tools), MATTE_MODEL.name), MATTE_MODEL.size)
  writeFileSync(
    join(tools.state, 'camera.json'),
    JSON.stringify({ version: 1, python: '3.12.0', opencv: '4.10', av: '12', completedAt: '2026-10-05T00:00:00.000Z', ...(onnx ? { onnxruntime: '1.20.0', providers, gpu } : {}) })
  )
  const dir = join(base, 'script')
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'camera_tools.js')
  writeFileSync(script, FAKE_SCRIPT)
  writeFileSync(join(dir, 'modo.txt'), 'ok')
  writeFileSync(join(dir, 'total.txt'), '3')
  return {
    tools,
    script,
    modo: (m) => writeFileSync(join(dir, 'modo.txt'), m),
    total: (n) => writeFileSync(join(dir, 'total.txt'), String(n)),
    pedido: () => JSON.parse(readFileSync(join(dir, 'pedido.json'), 'utf8'))
  }
}

const logger = createMemoryLogger()
const engineOf = (s: Setup, ffmpeg: string | null = 'C:\\ffmpeg\\ffmpeg.exe') =>
  createPythonCamera({ tools: s.tools, scriptPath: s.script, logger, ffmpeg: () => ffmpeg, now: () => new Date('2026-10-05T12:00:00.000Z') })

describe('o estado do recorte do fundo (check)', () => {
  it('sem a marca de preparo: tudo "falta preparar", com o motivo', async () => {
    const tools = toolPaths(tmp())
    const e = createPythonCamera({ tools, scriptPath: 'x', logger })
    const c = await e.check()
    expect(c.face.state).toBe('missing')
    expect(c.matte.state).toBe('missing')
    expect(c.matte.detail).toMatch(/não foi preparada/)
    expect(c.device).toBeNull()
  })

  it('com o modelo e a placa: pronto, e diz qual placa', async () => {
    const s = setup()
    const c = await engineOf(s).check()
    expect(c.face.state).toBe('ready')
    expect(c.matte).toEqual({ state: 'ready', detail: null })
    expect(c.device).toBe('NVIDIA GeForce RTX 3050 Laptop GPU')
  })

  it('sem a placa: pronto, mas avisa que vai rodar no processador, bem mais devagar', async () => {
    const s = setup({ providers: ['CPUExecutionProvider'], gpu: null })
    const c = await engineOf(s).check()
    expect(c.matte.state).toBe('ready')
    expect(c.matte.detail).toMatch(/processador/)
    expect(c.device).toBeNull()
  })

  it('preparado só com o rosto (sem onnxruntime na marca) ou com o modelo do recorte faltando: o recorte "falta", o rosto segue pronto', async () => {
    const semOnnx = await engineOf(setup({ onnx: false })).check()
    expect(semOnnx.face.state).toBe('ready')
    expect(semOnnx.matte.state).toBe('missing')
    expect(semOnnx.matte.detail).toMatch(/recorte do fundo/)
    const semModelo = await engineOf(setup({ matteModel: false })).check()
    expect(semModelo.face.state).toBe('ready')
    expect(semModelo.matte.state).toBe('missing')
  })

  it('modelo do recorte com o tamanho errado (download pela metade) não vale como pronto', async () => {
    const s = setup()
    sparse(join(cameraModelDir(s.tools), MATTE_MODEL.name), 1000)
    expect((await engineOf(s).check()).matte.state).toBe('missing')
  })
})

describe('makeMatte com o interpretador falso', () => {
  let s: Setup
  let video: string
  let out: string
  beforeAll(() => {
    s = setup()
    video = join(s.tools.base, 'camera.mp4')
    out = join(s.tools.base, 'saida', 'camera-matte.parcial.mp4')
    mkdirSync(join(s.tools.base, 'saida'), { recursive: true })
  })

  it('manda ao script o modelo, o ffmpeg do app, o lado maior e a saída; devolve o resultado e o progresso sobe sem andar para trás', async () => {
    s.modo('ok')
    const progress: number[] = []
    const r = await engineOf(s).makeMatte({ video, out, durationMs: 3000, onProgress: (f) => progress.push(f) })
    const req = s.pedido()
    expect(req.mode).toBe('matte')
    expect(req.video).toBe(video)
    expect(req.out).toBe(out)
    expect(req.model).toBe(join(cameraModelDir(s.tools), MATTE_MODEL.name))
    expect(req.ffmpeg).toBe('C:\\ffmpeg\\ffmpeg.exe')
    expect(req.maxSide).toBe(1280)
    expect(req.crf).toBeLessThanOrEqual(18)
    expect(existsSync(out)).toBe(true)
    expect(r).toMatchObject({ engine: MATTE_MODEL.id, device: 'cuda', frames: 90, fps: 30, frame: { w: 640, h: 360 }, seconds: 3, msPerFrame: 33.3 })
    expect(progress.length).toBeGreaterThanOrEqual(3)
    expect(progress.at(-1)).toBe(1)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
  })

  it('o script que falha: o erro dele aparece, com o que o app estava fazendo', async () => {
    s.modo('erro')
    await expect(engineOf(s).makeMatte({ video, out, durationMs: 3000 })).rejects.toThrow(/O recorte do fundo falhou: ERRO: o onnxruntime não abriu a placa/)
  })

  it('resposta que não é JSON e resposta sem quadros viram erro à vista (nunca um recorte vazio dado como bom)', async () => {
    s.modo('lixo')
    await expect(engineOf(s).makeMatte({ video, out, durationMs: 3000 })).rejects.toThrow(/não é JSON/)
    s.modo('vazio')
    await expect(engineOf(s).makeMatte({ video, out, durationMs: 3000 })).rejects.toThrow(/sem quadros/)
  })

  it('sem o ffmpeg do app: erro dizendo o que fazer', async () => {
    s.modo('ok')
    await expect(engineOf(s, null).makeMatte({ video, out, durationMs: 3000 })).rejects.toThrow(/ffmpeg/)
  })

  it('recusa caminho relativo ou que começa com "-" (nada vira opção de programa)', async () => {
    s.modo('ok')
    const e = engineOf(s)
    await expect(e.makeMatte({ video: 'camera.mp4', out, durationMs: 1000 })).rejects.toThrow(/Caminho inválido/)
    await expect(e.makeMatte({ video, out: 'saida.mp4', durationMs: 1000 })).rejects.toThrow(/Caminho inválido/)
    await expect(e.makeMatte({ video: '-i', out, durationMs: 1000 })).rejects.toThrow(/Caminho inválido/)
    await expect(e.makeMatte({ video, out: '-y', durationMs: 1000 })).rejects.toThrow(/Caminho inválido/)
  })

  it('motor não preparado para o recorte: o erro é o motivo do check, sem rodar nada', async () => {
    const semOnnx = setup({ onnx: false })
    await expect(engineOf(semOnnx).makeMatte({ video: join(semOnnx.tools.base, 'c.mp4'), out: join(semOnnx.tools.base, 'o.mp4'), durationMs: 1000 })).rejects.toThrow(/recorte do fundo ainda não está preparado/)
  })

  it('cancelar no meio derruba o processo e devolve erro (sem arquivo pronto)', async () => {
    s.modo('ok')
    const ctl = new AbortController()
    ctl.abort()
    await expect(engineOf(s).makeMatte({ video, out, durationMs: 3000, signal: ctl.signal })).rejects.toBeDefined()
  })
})

describe('makeMatte EM PEDAÇOS com o interpretador falso (e o ffmpeg de verdade juntando)', () => {
  const realFfmpeg = (): string => locateFfmpeg()!.ffmpeg
  let s: Setup
  let dir: string
  let video: string
  let out: string
  let stop: string
  beforeAll(() => {
    s = setup()
    dir = join(s.tools.base, 'pedacos ô')
    mkdirSync(dir, { recursive: true })
    video = join(s.tools.base, 'camera.mp4')
    out = join(s.tools.base, 'saida', 'camera-matte.partial.mp4')
    stop = join(dir, 'parar')
    mkdirSync(join(s.tools.base, 'saida'), { recursive: true })
  })
  const parts = (done: { index: number; frames: number; bytes: number }[], onChunk: (c: { index: number; frames: number; bytes: number }) => void = () => undefined) => ({ dir, chunkSeconds: 2, done, onChunk, stopFile: stop })

  it('pede os pedaços ao script (a partir do primeiro que falta), recebe cada um pelo stderr, junta tudo sem recodificar e confere a duração', async () => {
    s.modo('pedacos')
    s.total(3)
    const heard: number[] = []
    const r = await engineOf(s, realFfmpeg()).makeMatte({ video, out, durationMs: 4667, lowPriority: true, parts: parts([], (c) => heard.push(c.index)) })
    const req = s.pedido() as unknown as { mode: string; out?: string; parts: { dir: string; chunkSeconds: number; startChunk: number; warmupSeconds: number; stopFile: string }; lowPriority: boolean; parentPid: number; maxSide: number }
    expect(req.mode).toBe('matte')
    expect(req.out).toBeUndefined()
    expect(req.parts).toEqual({ dir, chunkSeconds: 2, startChunk: 0, warmupSeconds: 1, stopFile: stop })
    expect(req.lowPriority).toBe(true)
    expect(req.parentPid).toBe(process.pid)
    expect(req.maxSide).toBe(1280)
    expect(heard).toEqual([0, 1, 2])
    expect(r.stopped).toBeUndefined()
    expect(r.resume).toBeNull() // rodada que começou do zero
    expect(r.frames).toBe(140)
    expect(r.chunks?.map((c) => c.index)).toEqual([0, 1, 2])
    const v = probeJson(out).streams.find((x) => x.codec_type === 'video')!
    expect(Number(v.nb_frames)).toBe(140)
    expect(v.r_frame_rate).toBe('30/1')
    expect(Number(probeJson(out).format.duration)).toBeCloseTo(140 / 30, 2)
  })

  it('RETOMADA: com os dois primeiros pedaços já prontos o script recebe startChunk 2, faz só o que falta e o arquivo final tem tudo', async () => {
    s.modo('pedacos')
    s.total(3)
    const heard: number[] = []
    const done = [
      { index: 0, frames: 60, bytes: 0 },
      { index: 1, frames: 60, bytes: 0 }
    ]
    // os dois primeiros ficaram de uma rodada anterior (estão no disco, o script não os refaz)
    const r = await engineOf(s, realFfmpeg()).makeMatte({ video, out, durationMs: 4667, parts: parts(done, (c) => heard.push(c.index)) })
    expect((s.pedido() as unknown as { parts: { startChunk: number } }).parts.startChunk).toBe(2)
    expect(heard).toEqual([2])
    expect(r.resume).toBe('checkpoint')
    expect(r.frames).toBe(140)
    expect(r.chunks?.map((c) => c.index)).toEqual([0, 1, 2])
    expect(Number(probeJson(out).streams.find((x) => x.codec_type === 'video')!.nb_frames)).toBe(140)
  })

  it('PARADA a pedido: o script devolve "stopped" no fim de um pedaço, o motor não junta nada e devolve os pedaços prontos', async () => {
    s.modo('pedacos-parou')
    s.total(6)
    rmSync(out, { force: true })
    const r = await engineOf(s, realFfmpeg()).makeMatte({ video, out, durationMs: 11_000, parts: parts([{ index: 0, frames: 60, bytes: 0 }]) })
    expect(r.stopped).toBe(true)
    expect(r.chunks?.map((c) => c.index)).toEqual([0, 1])
    expect(existsSync(out)).toBe(false)
  })

  it('pedaço que falta no meio da conta: erro de junção (os pedaços não servem) em vez de um recorte curto dado como bom', async () => {
    s.modo('pedacos-buraco')
    s.total(3)
    rmSync(out, { force: true })
    await expect(engineOf(s, realFfmpeg()).makeMatte({ video, out, durationMs: 4667, parts: parts([]) })).rejects.toBeInstanceOf(MatteJoinError)
    expect(existsSync(out)).toBe(false)
  })

  it('recusa pasta de pedaços ou arquivo de parada relativos ou que viram opção', async () => {
    s.modo('pedacos')
    const e = engineOf(s, realFfmpeg())
    await expect(e.makeMatte({ video, out, durationMs: 1000, parts: { ...parts([]), dir: 'pedacos' } })).rejects.toThrow(/Caminho inválido/)
    await expect(e.makeMatte({ video, out, durationMs: 1000, parts: { ...parts([]), stopFile: '-y' } })).rejects.toThrow(/Caminho inválido/)
  })
})
