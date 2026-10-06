/**
 * O motor da câmera em Python (`createPythonCamera`) com um INTERPRETADOR FALSO (uma cópia do próprio Node no lugar do `python.exe` do
 * venv e um script de teste no lugar do `camera_tools.py`): prova o que o app faz AO REDOR do Python, sem instalar nada:
 *  - o estado do recorte do fundo (`check`): sem preparo, sem o modelo, com a placa, sem a placa (aviso do processador);
 *  - o pedido que vai ao script pelo stdin (o modelo, o ffmpeg do app, o lado maior, o caminho de saída);
 *  - o progresso vindo do stderr, o resultado, o erro do script com o motivo à vista e a recusa de caminhos suspeitos.
 * O motor DE VERDADE (RVM na placa) é provado em `camera-motor.test.ts`, que roda pela fila pesada.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createPythonCamera, MATTE_MODEL, YUNET_FILE, cameraModelDir } from '../../src/main/camera/python-engine'
import { createMemoryLogger } from '../../src/main/logger'
import { toolPaths, type ToolPaths } from '../../src/main/transcription/tools-dir'
import { useTmpDir } from '../helpers/env'

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
  fs.writeFileSync(req.out, 'máscara')
  process.stdout.write(JSON.stringify({ engine: 'rvm', device: 'cuda', frames: 90, fps: 30, frame: { w: 640, h: 360 }, stats: { seconds: 3, msPerFrame: 33.3 } }))
})
`

type Setup = { tools: ToolPaths; script: string; modo: (m: string) => void; pedido: () => { mode: string; video: string; out: string; model: string; ffmpeg: string; maxSide: number; crf: number } }

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
  return {
    tools,
    script,
    modo: (m) => writeFileSync(join(dir, 'modo.txt'), m),
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
