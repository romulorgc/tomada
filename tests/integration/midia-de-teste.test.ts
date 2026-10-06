/**
 * O gancho de mídia de TESTE (`src/main/test-media.ts`): a prova real grava a tela de verdade, sem microfone, e injeta a narração
 * (ou uma câmera com voz) como se o gravador a tivesse entregue, alinhada ao t0. O serviço de gravação inteiro, com ffmpeg de
 * verdade, fontes e rastreador falsos.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseProject } from '../../src/shared/project'
import type { ProcessSnapshot, StartedInfo, StopInfo } from '../../src/shared/ipc'
import type { RecordRequest } from '../../src/shared/recording'
import { ENV_TEST_CAMERA, ENV_TEST_VOICE, testMediaFromEnv } from '../../src/main/test-media'
import { FIX, requireFfmpeg, useTmpDir } from '../helpers/env'
import { createFakeWorld, type FakeWorld } from '../helpers/recording'

const tmp = useTmpDir()
const ff = requireFfmpeg()
const T0 = 5_000_000

let rawScreen: Buffer
let voiceWav: string
let cameraFile: string

beforeAll(async () => {
  const dir = tmp()
  mkdirSync(dir, { recursive: true })
  await ff.run(['-i', FIX.telaVfr, '-t', '2.8', '-c', 'copy', join(dir, 'tela.webm')])
  rawScreen = readFileSync(join(dir, 'tela.webm'))
  // 2,8 s de voz (a narração injetada) e de câmera com voz
  voiceWav = join(dir, 'narracao.wav')
  await ff.run(['-y', '-i', FIX.voz, '-t', '2.8', '-c:a', 'pcm_s16le', voiceWav])
  cameraFile = join(dir, 'rosto.mp4')
  await ff.run(['-y', '-i', FIX.camera, '-t', '2.8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', cameraFile])
})

const screenOnly: RecordRequest = { mode: 'screen', sourceId: 'screen:0:0', fps: 30, cameraId: null, micId: null, systemAudio: false, showBubble: false, hideCursor: true }

const startedInfo = (): StartedInfo => ({
  t0: T0,
  screenStartAt: T0,
  cameraStartAt: null,
  startEventLagMs: { screen: 210, camera: null },
  frame: { w: 1920, h: 1080 },
  clockOffsetMs: 0,
  clockRttMs: 0.1,
  screenMime: 'video/webm;codecs=vp9',
  cameraMime: null,
  screenHasAudio: false,
  cursorHidden: false,
  cameraHasVideo: false,
  cameraHasAudio: false,
  cameraSize: null
})
const stopInfo = (): StopInfo => ({ endedAt: T0 + 3000, reason: 'user', frame: { w: 1920, h: 1080 }, notes: [] })

async function waitDone(world: FakeWorld): Promise<ProcessSnapshot> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const finals = world.emitted.filter((e) => e.channel === 'process:progress' && e.payload.status !== 'running')
    if (finals.length > 0) return finals[finals.length - 1]!.payload as ProcessSnapshot
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('O processamento não terminou a tempo.')
}

async function recordScreenOnly(env: NodeJS.ProcessEnv): Promise<{ dir: string; snapshot: ProcessSnapshot }> {
  const root = join(tmp(), 'projetos')
  const world = createFakeWorld({ root, ffmpeg: ff, env })
  const prepared = await world.service.prepare(screenOnly)
  expect(await world.service.countdown()).toBe(true)
  await world.service.go()
  await world.service.started(startedInfo())
  for (let off = 0; off < rawScreen.length; off += 200_000) await world.service.chunk('screen', rawScreen.subarray(off, off + 200_000))
  await world.service.stop(stopInfo())
  const snapshot = await waitDone(world)
  return { dir: join(root, prepared.folder), snapshot }
}

describe('testMediaFromEnv', () => {
  it('sem variável nada é injetado', () => {
    expect(testMediaFromEnv({})).toBeNull()
    expect(testMediaFromEnv({ [ENV_TEST_VOICE]: '   ' })).toBeNull()
  })
  it('a câmera (que traz a voz junto) vale mais que a voz sozinha', () => {
    expect(testMediaFromEnv({ [ENV_TEST_VOICE]: 'C:\\v.wav' })).toEqual({ kind: 'voice', file: 'C:\\v.wav' })
    expect(testMediaFromEnv({ [ENV_TEST_VOICE]: 'C:\\v.wav', [ENV_TEST_CAMERA]: 'C:\\c.mp4' })).toEqual({ kind: 'camera', file: 'C:\\c.mp4' })
  })
})

describe('gravação só da tela com a voz injetada', () => {
  it('a gravação ganha a voz, SEM câmera, alinhada ao t0, e uma nota diz que é de teste', async () => {
    const { dir, snapshot } = await recordScreenOnly({ [ENV_TEST_VOICE]: voiceWav })
    expect(snapshot.status, JSON.stringify(snapshot.error)).toBe('done')
    expect(snapshot.steps.map((s) => s.id)).toContain('voice')
    expect(snapshot.steps.map((s) => s.id)).not.toContain('camera')
    expect(existsSync(join(dir, 'media/voice.wav'))).toBe(true)
    const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    expect(project.sources.voice?.path).toBe('media/voice.wav')
    expect(project.sources.camera).toBeUndefined()
    expect(project.sync.cameraOffsetMs).toBe(0) // a voz começa no t0
    expect(project.sources.voice!.durationMs).toBeGreaterThan(2500)
    expect(project.sources.voice!.durationMs).toBeLessThan(3200)
    const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { camera: { file: string; hasVideo: boolean; hasAudio: boolean }; notes: string[] }
    expect(manifest.camera).toMatchObject({ file: 'raw/mic.webm', hasVideo: false, hasAudio: true })
    expect(manifest.notes.some((n) => n.includes('TESTE') && n.includes(ENV_TEST_VOICE))).toBe(true)
    expect(snapshot.notes.some((n) => n.includes('TESTE'))).toBe(true)
  })

  it('com a câmera injetada: a gravação ganha o rosto E a voz (tela real, câmera de arquivo)', async () => {
    const { dir, snapshot } = await recordScreenOnly({ [ENV_TEST_CAMERA]: cameraFile })
    expect(snapshot.status, JSON.stringify(snapshot.error)).toBe('done')
    expect(snapshot.steps.map((s) => s.id)).toEqual(expect.arrayContaining(['screen', 'camera', 'voice']))
    const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    expect(project.sources.camera).toMatchObject({ path: 'media/camera.mp4' })
    expect(project.sources.voice?.path).toBe('media/voice.wav')
    expect(project.sync.cameraOffsetMs).toBe(0)
    const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { camera: { file: string; hasVideo: boolean; size: { w: number; h: number } | null } }
    expect(manifest.camera).toMatchObject({ file: 'raw/camera.webm', hasVideo: true })
    expect(manifest.camera.size).toEqual({ w: 640, h: 360 })
  })

  it('sem o gancho a gravação só da tela continua sem voz nem câmera (nada vaza para o uso normal)', async () => {
    const { dir, snapshot } = await recordScreenOnly({})
    expect(snapshot.status).toBe('done')
    expect(snapshot.steps.map((s) => s.id)).not.toContain('voice')
    const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    expect(project.sources.voice).toBeUndefined()
    expect(project.sources.camera).toBeUndefined()
  })

  it('arquivo que não existe: a gravação diz o motivo (nota e aviso) em vez de seguir sem a mídia calada', async () => {
    const root = join(tmp(), 'projetos')
    const world = createFakeWorld({ root, ffmpeg: ff, env: { [ENV_TEST_VOICE]: join(tmp(), 'nao-existe.wav') } })
    const prepared = await world.service.prepare(screenOnly)
    await world.service.countdown()
    await world.service.go()
    await world.service.started(startedInfo())
    for (let off = 0; off < rawScreen.length; off += 200_000) await world.service.chunk('screen', rawScreen.subarray(off, off + 200_000))
    await world.service.stop(stopInfo())
    await waitDone(world)
    const manifest = JSON.parse(readFileSync(join(root, prepared.folder, 'raw/recording.json'), 'utf8')) as { notes: string[] }
    expect(manifest.notes.some((n) => n.includes('Falha ao injetar a mídia de teste') && n.includes('não existe'))).toBe(true)
    expect(world.emitted.some((e) => e.channel === 'record:notice' && e.payload.kind === 'error')).toBe(true)
  })
})
