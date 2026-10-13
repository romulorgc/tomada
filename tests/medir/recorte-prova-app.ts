/**
 * O "app" mínimo da PROVA REAL do recorte retomável (`scripts/prova-recorte.mjs`): o serviço da câmera de verdade, com o motor de
 * verdade (RVM na placa, no venv do Python do app), o gate da placa e o log em arquivo, sem Electron. O script da prova o empacota
 * com o esbuild, abre como processo, MATA (sem aviso, como uma queda) ou manda fechar, e abre de novo.
 *
 *   node recorte-prova-app.cjs <pasta do projeto> <pasta dos logs> <modo>
 *
 *   pedir       pede o recorte (como o app faz logo depois de gravar) e espera terminar
 *   abrir       "abre o app": retoma o que ficou pela metade (`recoverMatte`) e espera terminar
 *   referencia  roda o motor de uma vez só, sem pedaços, em `media/camera-matte-referencia.mp4` (para comparar os quadros)
 *
 * Variáveis: TOMADA_PROVA_RAIZ (a raiz do repositório), TOMADA_PROVA_PEDACO (segundos de cada pedaço; o padrão do app é 10).
 * Cada evento sai em uma linha JSON no stdout; "fechar" no stdin faz o mesmo que o app ao sair: `shutdown()` do serviço.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CameraJob } from '@shared/camera-analysis'
import { parseProject } from '@shared/project'
import { createPythonCamera } from '../../src/main/camera/python-engine'
import { createCameraService } from '../../src/main/camera/service'
import { locateFfmpeg } from '../../src/main/ffmpeg'
import { createGpuQueue } from '../../src/main/gpu-queue'
import { createLogger } from '../../src/main/logger'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'

const [projectDir, logsDir, mode] = process.argv.slice(2)
if (!projectDir || !logsDir || !mode) throw new Error('uso: recorte-prova-app <pasta do projeto> <pasta dos logs> <pedir|abrir|referencia>')
const root = process.env.TOMADA_PROVA_RAIZ ?? process.cwd()
const PROJECT_ID = 'projeto'

const say = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ t: Date.now(), ...event })}\n`)
}

const logger = createLogger(logsDir)
const engine = createPythonCamera({
  tools: toolPaths(ensureToolsDir()),
  scriptPath: join(root, 'resources', 'camera_tools.py'),
  logger,
  ffmpeg: () => locateFfmpeg()?.ffmpeg ?? null
})
const read = async (): Promise<{ project: ReturnType<typeof parseProject>; dir: string }> => ({ project: parseProject(readFileSync(join(projectDir, 'project.json'), 'utf8')), dir: projectDir })
const chunkSeconds = process.env.TOMADA_PROVA_PEDACO ? Number(process.env.TOMADA_PROVA_PEDACO) : undefined
const service = createCameraService({
  logger,
  engine,
  read,
  gpu: createGpuQueue().gate,
  ...(chunkSeconds ? { chunkSeconds } : {}),
  emit: (channel, payload) => {
    if (channel !== 'camera:job') return
    const job = payload as CameraJob
    if (job.kind === 'matte') say({ evento: 'job', estado: job.state, fracao: Number(job.fraction.toFixed(3)), retomado: job.resumed === true, esperando: job.waiting ?? null, erro: job.error ?? null })
  }
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (text: string) => {
  if (!text.includes('fechar')) return
  // o que o app faz ao sair (`before-quit`): o recorte em curso fica anotado como interrompido, no log e no projeto
  say({ evento: 'fechando' })
  void service.shutdown().then(() => {
    say({ evento: 'fechado' })
    process.exit(0)
  })
})

async function main(): Promise<void> {
  say({ evento: 'aberto', modo: mode, pid: process.pid })
  if (mode === 'referencia') {
    const { project } = await read()
    const out = join(projectDir, 'media', 'camera-matte-referencia.mp4')
    const started = Date.now()
    const result = await engine.makeMatte({ video: join(projectDir, project.sources.camera!.path), out, durationMs: project.sources.camera!.durationMs })
    say({ evento: 'referencia', quadros: result.frames, segundos: (Date.now() - started) / 1000 })
    return
  }
  if (mode === 'abrir') say({ evento: 'recuperar', resultado: await service.recoverMatte(PROJECT_ID) })
  else if (mode === 'pedir') {
    const job = await service.analyze(PROJECT_ID, 'matte')
    say({ evento: 'pedido', estado: job.state })
  } else throw new Error(`modo desconhecido: ${mode}`)
  await service.idle()
  say({ evento: 'pronto' })
}

main().then(
  () => process.exit(0),
  (err) => {
    say({ evento: 'erro', erro: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  }
)
