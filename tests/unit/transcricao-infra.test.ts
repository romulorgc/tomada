/**
 * A infraestrutura da transcrição que não depende de Python nem de placa: onde ficam as ferramentas (e o desvio do
 * "ô" de `C:\Users\José`), a escolha do Python, a leitura do progresso do pip, o rastreador de passos da preparação
 * e o processo filho (stdin, ambiente limpo, tempo limite, cancelamento).
 */
import { describe, expect, it } from 'vitest'
import { ProcessError, childEnv, runProcess, tail } from '../../src/main/process-runner'
import { parsePipDownloadLine, parsePipProgressLine } from '../../src/main/transcription/faster-whisper'
import { createPrepareTracker, bytesLine } from '../../src/main/transcription/prepare-tracker'
import { PythonNotFoundError, locatePython, parsePyListing, pythonPreference } from '../../src/main/transcription/python-locator'
import { ENV_TOOLS_DIR, ToolsDirError, isAscii, resolveToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import { BASE_PROMPT, buildHotwords, buildPrompt } from '../../src/main/transcription/types'
import type { PrepareSnapshot } from '@shared/transcription'

describe('pasta das ferramentas', () => {
  it('TOMADA_TOOLS_DIR manda (e precisa ser sem acento)', () => {
    expect(resolveToolsDir({ env: { [ENV_TOOLS_DIR]: 'C:\\tmp\\ferramentas' } })).toBe('C:\\tmp\\ferramentas')
    expect(() => resolveToolsDir({ env: { [ENV_TOOLS_DIR]: 'C:\\Users\\José\\x' } })).toThrow(ToolsDirError)
  })

  it('sem acento: %LOCALAPPDATA%\\Tomada', () => {
    expect(resolveToolsDir({ env: { LOCALAPPDATA: 'C:\\Users\\Maria\\AppData\\Local' } })).toBe('C:\\Users\\Maria\\AppData\\Local\\Tomada')
  })

  it('com acento (esta máquina): usa o nome curto 8.3', () => {
    const dir = resolveToolsDir({ env: { LOCALAPPDATA: 'C:\\Users\\José\\AppData\\Local' }, shortPathOf: (p) => (p.includes('José') ? 'C:\\Users\\JOS~1\\AppData\\Local' : null) })
    expect(dir).toBe('C:\\Users\\JOS~1\\AppData\\Local\\Tomada')
    expect(isAscii(dir)).toBe(true)
  })

  it('sem nome curto (volume sem 8.3) ou com um que ainda tem acento: cai em %ProgramData%\\Tomada', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\José\\AppData\\Local', ProgramData: 'C:\\ProgramData' }
    expect(resolveToolsDir({ env, shortPathOf: () => null })).toBe('C:\\ProgramData\\Tomada')
    expect(resolveToolsDir({ env, shortPathOf: () => 'C:\\Users\\José\\AppData\\Local' })).toBe('C:\\ProgramData\\Tomada')
  })

  it('nada serve: erro com o motivo, em português', () => {
    expect(() => resolveToolsDir({ env: { LOCALAPPDATA: 'C:\\Usuários\\José\\Local', ProgramData: 'D:\\Dados Programáticos' }, shortPathOf: () => null })).toThrow(/sem acentos/)
  })

  it('as subpastas ficam todas DENTRO da pasta base', () => {
    const t = toolPaths('C:\\ferramentas')
    for (const [name, path] of Object.entries(t)) {
      if (name === 'base') continue
      expect(path.startsWith('C:\\ferramentas\\'), name).toBe(true)
    }
  })
})

describe('Python', () => {
  it('lê só as etiquetas ASCII do `py -0p`, na ordem, sem repetir e sem os colchetes', () => {
    const text = [
      'Installed Pythons found by py Launcher for Windows',
      ' -V:Astral/CPython3.14.0 *        C:\\Users\\R?mulo\\AppData\\Roaming\\uv\\python\\cpython-3.14\\python.exe',
      ' -V:3.11[-64]                      C:\\Python311\\python.exe',
      ' -V:3.11                           C:\\Python311\\python.exe',
      ' sem etiqueta aqui'
    ].join('\r\n')
    expect(parsePyListing(text)).toEqual(['Astral/CPython3.14.0', '3.11'])
    expect(parsePyListing('')).toEqual([])
  })

  it('prefere o 3.11 e deixa o 3.14 por último', () => {
    const order = [14, 9, 12, 11, 13, 10].sort((a, b) => pythonPreference(a) - pythonPreference(b))
    expect(order).toEqual([11, 12, 10, 13, 9, 14])
    expect(pythonPreference(8)).toBeGreaterThan(pythonPreference(14))
  })

  it('escolhe o melhor dos encontrados e lê o caminho do próprio Python (JSON), não do texto do console', async () => {
    const run = (async (_exe: string, args: readonly string[]) => {
      if (args.includes('-0p')) return { stdout: ' -V:3.12 x\n -V:3.11 y\n -V:3.8 z\n', stderr: '', exitCode: 0 as const }
      const tag = args[0]!.replace('-V:', '')
      const [maj, min] = tag.split('.').map(Number)
      return { stdout: `${JSON.stringify([`C:\\Users\\José\\py${tag}\\python.exe`, [maj, min, 7]])}\n`, stderr: '', exitCode: 0 as const }
    }) as typeof runProcess
    const py = await locatePython(run, { SystemRoot: 'C:\\Windows' })
    expect(py.version).toEqual([3, 11, 7])
    expect(py.exe).toBe('C:\\Users\\José\\py3.11\\python.exe')
    expect(py.prefix).toEqual([])
  })

  it('ignora o atalho da Microsoft Store e diz o que fazer quando não há Python', async () => {
    const run = (async (_exe: string, args: readonly string[]) => {
      if (args.includes('-0p')) throw new Error('sem py')
      return { stdout: `${JSON.stringify(['C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe', [3, 11, 0]])}\n`, stderr: '', exitCode: 0 as const }
    }) as typeof runProcess
    const err = await locatePython(run, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PythonNotFoundError)
    expect((err as Error).message).toMatch(/Instale o Python 3\.11/)
  })

  it('versão fora de 3.9–3.14 não serve', async () => {
    const run = (async (_exe: string, args: readonly string[]) => {
      if (args.includes('-0p')) return { stdout: ' -V:3.8 x\n', stderr: '', exitCode: 0 as const }
      return { stdout: `${JSON.stringify(['C:\\py\\python.exe', [3, 8, 10]])}\n`, stderr: '', exitCode: 0 as const }
    }) as typeof runProcess
    await expect(locatePython(run, {})).rejects.toBeInstanceOf(PythonNotFoundError)
  })
})

describe('progresso do pip', () => {
  it('Downloading ... (743.1 MB)', () => {
    expect(parsePipDownloadLine('Downloading nvidia_cudnn_cu12-9.27.0.42-py3-none-win_amd64.whl (743.1 MB)')).toEqual({ name: 'nvidia_cudnn_cu12-9.27.0.42-py3-none-win_amd64.whl', bytes: 743_100_000 })
    expect(parsePipDownloadLine('Using cached ctranslate2-4.8.2-cp311-cp311-win_amd64.whl (12.3 MB)')?.bytes).toBe(12_300_000)
    expect(parsePipDownloadLine('Downloading numpy-2.0.0-cp311-win_amd64.whl (1,2 kB)')?.bytes).toBe(1200)
  })

  it('ignora o que não é rodas (metadados, texto solto)', () => {
    expect(parsePipDownloadLine('Downloading pkg-1.0.whl.metadata (4.0 kB)')).toBeNull()
    expect(parsePipDownloadLine('Collecting faster-whisper==1.2.1')).toBeNull()
    expect(parsePipDownloadLine('')).toBeNull()
  })

  it('Progress a of b (--progress-bar raw)', () => {
    expect(parsePipProgressLine('Progress 262144 of 27595679')).toEqual({ current: 262_144, total: 27_595_679 })
    expect(parsePipProgressLine('Progress x of y')).toBeNull()
  })
})

describe('rastreador da preparação', () => {
  const run = () => {
    const seen: PrepareSnapshot[] = []
    let t = 1000
    const tracker = createPrepareTracker('faster-whisper', [{ id: 'python', weight: 10 }, { id: 'packages', weight: 30 }, { id: 'model', weight: 60 }], (s) => seen.push(s), () => (t += 500))
    return { tracker, seen }
  }

  it('a fração total pesa cada passo pelo que ele baixa e nunca chega a 100% antes de terminar', () => {
    const { tracker } = run()
    expect(tracker.snapshot().fraction).toBe(0)
    tracker.begin('python')
    tracker.done('python')
    expect(tracker.snapshot().fraction).toBeCloseTo(0.1)
    tracker.begin('packages')
    tracker.progress('packages', 0.5)
    expect(tracker.snapshot().fraction).toBeCloseTo(0.25)
    tracker.done('packages')
    tracker.progress('model', 1)
    expect(tracker.snapshot().fraction).toBeLessThan(1)
    tracker.done('model')
    expect(tracker.snapshot().status).toBe('running')
    tracker.finish()
    expect(tracker.snapshot()).toMatchObject({ status: 'done', fraction: 1 })
  })

  it('erro guarda o passo e a mensagem; cancelar muda o estado; avisos de bastidor ficam (até 20)', () => {
    const { tracker, seen } = run()
    tracker.begin('packages', 'baixando')
    tracker.fail('packages', 'sem rede')
    expect(tracker.snapshot()).toMatchObject({ status: 'error', error: { step: 'packages', message: 'sem rede' } })
    expect(tracker.snapshot().steps.find((s) => s.id === 'packages')).toMatchObject({ status: 'error', detail: 'sem rede' })
    for (let k = 0; k < 25; k++) tracker.note(`aviso ${k}`)
    expect(tracker.snapshot().notes).toHaveLength(20)
    expect(tracker.snapshot().notes.at(-1)).toBe('aviso 24')
    tracker.cancelled()
    expect(tracker.snapshot().status).toBe('cancelled')
    expect(seen.length).toBeGreaterThan(3)
  })

  it('fração de passo é limitada a 0..1 e passo desconhecido é erro de programação', () => {
    const { tracker } = run()
    tracker.progress('model', 5)
    expect(tracker.snapshot().steps.find((s) => s.id === 'model')!.fraction).toBe(1)
    tracker.progress('model', -3)
    expect(tracker.snapshot().steps.find((s) => s.id === 'model')!.fraction).toBe(0)
    expect(() => tracker.begin('check')).toThrow(/desconhecido/)
  })

  it('não inunda a interface: progresso muito seguido é agrupado, o resto sai na hora', () => {
    const seen: PrepareSnapshot[] = []
    const tracker = createPrepareTracker('mock', [{ id: 'model', weight: 1 }], (s) => seen.push(s), () => 5000)
    tracker.begin('model')
    for (let k = 0; k < 50; k++) tracker.progress('model', k / 50)
    expect(seen.length).toBeLessThan(5)
    tracker.done('model')
    expect(seen.at(-1)!.steps[0]!.status).toBe('done')
  })

  it('bytesLine: "412 MB de 1,5 GB"', () => {
    expect(bytesLine(412 * 1024 ** 2, 1.5 * 1024 ** 3)).toBe('412 MB de 1,5 GB')
    expect(bytesLine(10 * 1024 ** 2, null)).toBe('10 MB')
  })
})

describe('prompt e dicionário', () => {
  it('o prompt semeia as hesitações e leva o dicionário', () => {
    expect(buildPrompt()).toBe(BASE_PROMPT)
    expect(buildPrompt(['Kubernetes', ' Tomada ', ''])).toBe(`${BASE_PROMPT} Kubernetes, Tomada.`)
    expect(buildHotwords(['Kubernetes', ' Tomada ', ''])).toBe('Kubernetes Tomada')
    expect(buildHotwords()).toBe('')
  })
})

describe('processo filho', () => {
  const node = process.execPath

  it('o texto longo entra pelo stdin (nunca pela linha de comando) e a saída volta inteira, com acento', async () => {
    const text = `${'á'.repeat(50_000)} ôlá`
    const r = await runProcess(node, ['-e', "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.length+'|'+d.slice(-4)))"], { stdin: text })
    expect(r.stdout).toBe(`${text.length}|${text.slice(-4)}`)
  })

  it('ELECTRON_RUN_AS_NODE não é herdada pelo filho; o resto do ambiente e o que se pede, sim', async () => {
    const before = process.env.ELECTRON_RUN_AS_NODE
    process.env.ELECTRON_RUN_AS_NODE = '1'
    try {
      expect(childEnv().ELECTRON_RUN_AS_NODE).toBeUndefined()
      expect(childEnv({}, { electron_run_as_node: '1', A: 'b' })).toEqual({ A: 'b' })
      const r = await runProcess(node, ['-e', 'process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE)+"|"+process.env.MINHA)'], { env: { MINHA: 'x' } })
      expect(r.stdout).toBe('undefined|x')
    } finally {
      if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = before
    }
  })

  it('não passa por shell: caracteres especiais nos argumentos chegam como texto', async () => {
    const evil = 'a & echo PWNED | b > c; $(x) `y`'
    const r = await runProcess(node, ['-e', 'process.stdout.write(process.argv[1])', evil])
    expect(r.stdout).toBe(evil)
  })

  it('código de saída diferente de zero vira erro com o rabo da mensagem do programa', async () => {
    const err = await runProcess(node, ['-e', "console.error('linha 1');console.error('o motivo real');process.exit(3)"]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProcessError)
    expect((err as ProcessError).reason).toBe('exit')
    expect((err as ProcessError).exitCode).toBe(3)
    expect((err as ProcessError).message).toContain('o motivo real')
  })

  it('estourar o tempo mata o processo e diz que foi o tempo', async () => {
    const t0 = Date.now()
    const err = await runProcess(node, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 300 }).catch((e: unknown) => e)
    expect((err as ProcessError).reason).toBe('timeout')
    expect((err as ProcessError).message).toMatch(/tempo limite/)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('cancelar (antes ou durante) rejeita com "Cancelado."', async () => {
    const early = new AbortController()
    early.abort()
    await expect(runProcess(node, ['-e', ''], { signal: early.signal })).rejects.toMatchObject({ reason: 'cancelled' })
    const ctl = new AbortController()
    const p = runProcess(node, ['-e', 'setTimeout(()=>{},60000)'], { signal: ctl.signal })
    setTimeout(() => ctl.abort(), 150)
    await expect(p).rejects.toMatchObject({ reason: 'cancelled', message: 'Cancelado.' })
  })

  it('programa que não existe: erro de partida legível', async () => {
    const err = await runProcess('C:\\nao\\existe\\programa.exe', []).catch((e: unknown) => e)
    expect((err as ProcessError).reason).toBe('spawn')
    expect((err as ProcessError).message).toMatch(/Não achei o programa/)
  })

  it('onStdout/onStderr entregam o texto à medida que chega; tail pega as últimas linhas', async () => {
    const out: string[] = []
    await runProcess(node, ['-e', "process.stdout.write('um\\n');setTimeout(()=>process.stdout.write('dois\\n'),50)"], { onStdout: (t) => out.push(t) })
    expect(out.join('')).toBe('um\ndois\n')
    expect(tail('a\n\nb\r\nc\n', 2)).toBe('b\nc')
  })
})
