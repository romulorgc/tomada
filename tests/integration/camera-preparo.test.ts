/**
 * A PREPARAÇÃO da análise da câmera (`createPythonCamera().prepare`) com o Python, o pip e os downloads FALSOS (injetados): prova a ordem
 * e os argumentos do que o app executa, sem instalar nada. Cobre os defeitos da revisão independente:
 *  - cancelar (ou duvidar de) a verificação de um venv SAUDÁVEL nunca o apaga: o venv é compartilhado com a transcrição;
 *  - o pip velho de um venv novo é atualizado ANTES de `--progress-bar raw` (que só existe do pip 25.1);
 *  - o rosto e o recorte do fundo se preparam em trilhas INDEPENDENTES: o download do RVM caindo não derruba o rosto.
 */
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAMERA_STEPS, createPythonCamera, MATTE_MODEL, mattePath, YUNET_FILE, yunetPath } from '../../src/main/camera/python-engine'
import { createMemoryLogger } from '../../src/main/logger'
import { ProcessError, type runProcess } from '../../src/main/process-runner'
import { DownloadError, type downloadFile } from '../../src/main/transcription/download'
import { venvPython } from '../../src/main/transcription/faster-whisper'
import { createPrepareTracker } from '../../src/main/transcription/prepare-tracker'
import { toolPaths } from '../../src/main/transcription/tools-dir'
import type { PrepareSnapshot } from '../../src/shared/transcription'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir()

const CHECK_OK = { python: '3.12.1', opencv: '4.10.0', av: '12.0.0', yunet: true, onnxruntime: '1.20.1', providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'] }

type Call = { exe: string; args: string[] }
type Verify = 'ok' | 'exit' | 'timeout' | 'abort' | 'spawn'

function sparse(path: string, size: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  truncateSync(path, size)
}

function setup(o: { venv?: boolean; verify?: Verify; pip?: string; check?: { yunet?: boolean; onnxruntime?: string | null }; downloadFails?: 'yunet' | 'matte'; pipFails?: 'matte' } = {}) {
  const base = tmp()
  const tools = toolPaths(base)
  const ctl = new AbortController()
  const calls: Call[] = []
  const downloads: string[] = []
  let located = 0
  if (o.venv !== false) {
    mkdirSync(dirname(venvPython(tools)), { recursive: true })
    writeFileSync(venvPython(tools), '')
    // um arquivo "da transcrição" dentro do venv compartilhado: não pode sumir
    mkdirSync(join(tools.venv, 'Lib', 'site-packages', 'faster_whisper'), { recursive: true })
    writeFileSync(join(tools.venv, 'Lib', 'site-packages', 'faster_whisper', '__init__.py'), '# da transcricao')
  }
  const result = (stdout = ''): { stdout: string; stderr: string; exitCode: 0 } => ({ stdout, stderr: '', exitCode: 0 })
  const run = (async (exe: string, args: readonly string[]) => {
    calls.push({ exe, args: [...args] })
    if (args[0] === '-c') {
      const verify = o.verify ?? 'ok'
      if (verify === 'abort') {
        ctl.abort()
        throw new ProcessError('Cancelado.', 'cancelled', null, '', '')
      }
      if (verify === 'timeout') throw new ProcessError('O programa passou do tempo limite (30 s) e foi interrompido.', 'timeout', null, '', '')
      if (verify === 'exit') throw new ProcessError('O programa terminou com código 103.', 'exit', 103, '', 'No Python at ...')
      if (verify === 'spawn') throw new ProcessError('Não achei o programa.', 'spawn', null, '', '')
      return result('3.12.1\n')
    }
    if (args[0] === '-m' && args[1] === 'venv') {
      mkdirSync(dirname(venvPython(tools)), { recursive: true })
      writeFileSync(venvPython(tools), '')
      return result()
    }
    if (args[0] === '-m' && args[1] === 'pip' && args[2] === '--version') return result(`pip ${o.pip ?? '25.2'} from C:\\x\\pip (python 3.12)\n`)
    if (args[0] === '-m' && args[1] === 'pip' && args[2] === 'install') {
      if (o.pipFails === 'matte' && args.some((a) => a.startsWith('onnxruntime'))) throw new ProcessError('O programa terminou com código 1.', 'exit', 1, '', 'ERROR: No matching distribution found for onnxruntime')
      return result()
    }
    if (args[1] === '--check') {
      const info = { ...CHECK_OK, ...o.check }
      return result(`${JSON.stringify(info)}\n`)
    }
    throw new Error(`chamada inesperada: ${exe} ${args.join(' ')}`)
  }) as unknown as typeof runProcess
  const download = (async (spec: { url: string; dest: string; size?: number }) => {
    downloads.push(spec.url)
    const isMatte = spec.url === MATTE_MODEL.url
    if ((o.downloadFails === 'matte' && isMatte) || (o.downloadFails === 'yunet' && !isMatte)) throw new DownloadError('A rede caiu durante o download.', true)
    sparse(spec.dest, spec.size ?? 1)
    return { bytes: spec.size ?? 1 }
  }) as unknown as typeof downloadFile
  const engine = createPythonCamera({
    tools,
    scriptPath: 'C:\\app\\resources\\camera_tools.py',
    logger: createMemoryLogger(),
    run,
    download,
    locate: async () => {
      located++
      return { exe: 'C:\\Python312\\python.exe', prefix: [], version: [3, 12, 1] }
    },
    detectGpu: async () => ({ name: 'NVIDIA GeForce RTX 3050 Laptop GPU' }),
    now: () => new Date('2026-10-05T12:00:00.000Z')
  })
  const snapshots: PrepareSnapshot[] = []
  const tracker = createPrepareTracker('camera', CAMERA_STEPS, (s) => snapshots.push(s))
  const sentinel = join(tools.venv, 'Lib', 'site-packages', 'faster_whisper', '__init__.py')
  return { tools, engine, tracker, ctl, calls, downloads, located: () => located, snapshots, sentinel }
}

const installs = (calls: Call[]): Call[] => calls.filter((c) => c.args[2] === 'install')

describe('venv compartilhado com a transcrição: verificar não destrói', () => {
  it('cancelar DURANTE a verificação de um venv saudável: o cancelamento sobe, o venv e os pacotes dele continuam lá, nada é recriado', async () => {
    const s = setup({ verify: 'abort' })
    await expect(s.engine.prepare(s.tracker, s.ctl.signal)).rejects.toThrow()
    expect(s.tracker.snapshot().status).toBe('cancelled')
    expect(existsSync(s.sentinel), 'o venv compartilhado foi apagado por um cancelamento').toBe(true)
    expect(s.located(), 'cancelar não pode virar "recriar o ambiente"').toBe(0)
    expect(s.calls.some((c) => c.args[1] === 'venv')).toBe(false)
  })

  it('a verificação estourou o tempo (dúvida, não prova de que quebrou): erro à vista, venv intacto', async () => {
    const s = setup({ verify: 'timeout' })
    await expect(s.engine.prepare(s.tracker, s.ctl.signal)).rejects.toThrow(/tempo limite/)
    expect(s.tracker.snapshot().status).toBe('error')
    expect(existsSync(s.sentinel)).toBe(true)
    expect(s.located()).toBe(0)
  })

  it('o Python do venv abriu e FALHOU (quebrado de verdade, como o interpretador base desinstalado): aí sim recria o ambiente', async () => {
    const s = setup({ verify: 'exit' })
    await s.engine.prepare(s.tracker, s.ctl.signal)
    expect(existsSync(s.sentinel)).toBe(false)
    expect(s.located()).toBe(1)
    expect(s.calls.some((c) => c.args[1] === 'venv')).toBe(true)
    expect(s.tracker.snapshot().status).toBe('running') // quem fecha o rastreador é o serviço
    expect(s.tracker.snapshot().steps.every((st) => st.status === 'done')).toBe(true)
  })

  it('sem venv nenhum: cria (e não pergunta nada a um Python que não existe)', async () => {
    const s = setup({ venv: false })
    await s.engine.prepare(s.tracker, s.ctl.signal)
    expect(s.located()).toBe(1)
    expect(s.calls.find((c) => c.args[0] === '-c')).toBeUndefined()
  })
})

describe('pip: a barra raw só existe do 25.1 em diante', () => {
  it('venv com pip 24: atualiza o pip SEM a barra raw antes do primeiro `install --progress-bar raw`', async () => {
    const s = setup({ pip: '24.0' })
    await s.engine.prepare(s.tracker, s.ctl.signal)
    const all = s.calls.map((c) => c.args.join(' '))
    const versionAt = all.findIndex((a) => a === '-m pip --version')
    const upgradeAt = all.findIndex((a) => a.includes('install') && a.includes('--upgrade pip'))
    const firstRawAt = all.findIndex((a) => a.includes('install') && a.includes('--progress-bar raw'))
    expect(versionAt, 'o app não consultou a versão do pip').toBeGreaterThanOrEqual(0)
    expect(upgradeAt).toBeGreaterThan(versionAt)
    expect(all[upgradeAt]).not.toContain('--progress-bar')
    expect(firstRawAt).toBeGreaterThan(upgradeAt)
    // e nenhum install com a barra raw antes da atualização
    expect(all.slice(0, upgradeAt).some((a) => a.includes('--progress-bar raw'))).toBe(false)
  })

  it('pip 25.1 ou mais novo: não atualiza nada, instala direto com a barra', async () => {
    const s = setup({ pip: '25.1.1' })
    await s.engine.prepare(s.tracker, s.ctl.signal)
    expect(installs(s.calls).some((c) => c.args.includes('--upgrade'))).toBe(false)
    expect(installs(s.calls).every((c) => c.args.includes('--progress-bar'))).toBe(true)
  })
})

describe('trilhas independentes: o rosto e o recorte do fundo', () => {
  it('tudo certo: os 7 passos terminam, a marca leva o onnxruntime e o estado diz rosto e recorte prontos', async () => {
    const s = setup()
    await s.engine.prepare(s.tracker, s.ctl.signal)
    const steps = s.tracker.snapshot().steps
    expect(steps.map((st) => st.id)).toEqual(['python', 'packages', 'model', 'check', 'matte-packages', 'matte-model', 'matte-check'])
    expect(steps.every((st) => st.status === 'done')).toBe(true)
    const marker = JSON.parse(readFileSync(join(s.tools.state, 'camera.json'), 'utf8')) as { onnxruntime?: string; providers?: string[]; gpu?: string }
    expect(marker.onnxruntime).toBe('1.20.1')
    expect(marker.providers).toContain('CUDAExecutionProvider')
    const c = await s.engine.check()
    expect(c.face.state).toBe('ready')
    expect(c.matte.state).toBe('ready')
    expect(c.device).toMatch(/RTX 3050/)
  })

  it('o download do modelo do recorte (RVM) cai: o erro aponta o passo do recorte, e o ROSTO já está pronto e disponível', async () => {
    const s = setup({ downloadFails: 'matte' })
    await expect(s.engine.prepare(s.tracker, s.ctl.signal)).rejects.toThrow(/rede/)
    const c = await s.engine.check()
    expect(c.face, 'o recorte falhou e levou o rosto junto').toEqual({ state: 'ready', detail: null })
    expect(c.matte.state).toBe('missing')
    const snap = s.tracker.snapshot()
    expect(snap.status).toBe('error')
    expect(snap.error?.step).toBe('matte-model')
    expect(snap.steps.filter((st) => st.status === 'done').map((st) => st.id)).toEqual(['python', 'packages', 'model', 'check', 'matte-packages'])
    expect(existsSync(yunetPath(s.tools))).toBe(true)
    expect(existsSync(mattePath(s.tools))).toBe(false)
  })

  it('o pip do onnxruntime falha: o rosto segue pronto e o erro cai no passo do recorte', async () => {
    const s = setup({ pipFails: 'matte' })
    await expect(s.engine.prepare(s.tracker, s.ctl.signal)).rejects.toThrow()
    expect((await s.engine.check()).face.state, 'o recorte falhou e levou o rosto junto').toBe('ready')
    expect(s.tracker.snapshot().error?.step).toBe('matte-packages')
    expect(s.downloads).toEqual([YUNET_FILE.url]) // nem tentou baixar o RVM
  })

  it('o onnxruntime não abre na conferência: o rosto fica pronto, o recorte "falta" e o motivo vem junto', async () => {
    const s = setup({ check: { onnxruntime: null } })
    await expect(s.engine.prepare(s.tracker, s.ctl.signal)).rejects.toThrow(/onnxruntime/)
    const c = await s.engine.check()
    expect(c.face.state, 'o recorte falhou e levou o rosto junto').toBe('ready')
    expect(c.matte.state).toBe('missing')
    expect(s.tracker.snapshot().error?.step).toBe('matte-check')
  })

  it('o detector de rosto falha na conferência: nada fica marcado como pronto', async () => {
    const s = setup({ check: { yunet: false } })
    await expect(s.engine.prepare(s.tracker, s.ctl.signal)).rejects.toThrow(/detector de rosto/)
    expect(s.tracker.snapshot().error?.step).toBe('check')
    expect((await s.engine.check()).face.state).toBe('missing')
  })
})
