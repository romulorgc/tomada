/**
 * O serviço de gravação inteiro (preparar → contagem → gravar → pausar → parar → processar)
 * com ffmpeg de verdade e arquivos brutos de verdade (cortes dos fixtures), mas com fontes,
 * janelas e rastreador falsos. O que depende do Electron é provado nos e2e e na captura real.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseProject } from '../../src/shared/project'
import type { ProcessSnapshot, StartedInfo, StopInfo } from '../../src/shared/ipc'
import type { RawEvents, RecordRequest } from '../../src/shared/recording'
import { FIX, requireFfmpeg, useTmpDir } from '../helpers/env'
import { createFakeWorld, SCREEN_SOURCE, WINDOW_SOURCE, type FakeWorld } from '../helpers/recording'

const tmp = useTmpDir()
const ff = requireFfmpeg()
const T0 = 5_000_000

let rawScreen: Buffer
let rawCamera: Buffer
let rawMic: Buffer

beforeAll(async () => {
  // Cortes de 2,8 s dos fixtures (cópia de fluxo, sem recodificar): tela VFR em VP9, câmera+voz em
  // VP9/Opus e só a voz. 2,8 s = os 3 s do teste menos os 200 ms de pausa (o MediaRecorder pula a pausa).
  const dir = tmp()
  mkdirSync(dir, { recursive: true })
  await ff.run(['-i', FIX.telaVfr, '-t', '2.8', '-c', 'copy', join(dir, 'tela.webm')])
  await ff.run(['-i', FIX.camera, '-t', '2.8', '-c', 'copy', join(dir, 'camera.webm')])
  await ff.run(['-i', FIX.camera, '-t', '2.8', '-vn', '-c', 'copy', join(dir, 'mic.webm')])
  rawScreen = readFileSync(join(dir, 'tela.webm'))
  rawCamera = readFileSync(join(dir, 'camera.webm'))
  rawMic = readFileSync(join(dir, 'mic.webm'))
})

const baseRequest: RecordRequest = {
  mode: 'screen-camera',
  sourceId: 'screen:0:0',
  fps: 30,
  cameraId: 'cam-1',
  micId: 'mic-1',
  systemAudio: false,
  showBubble: true,
  hideCursor: true
}

function startedInfo(over: Partial<StartedInfo> = {}): StartedInfo {
  return {
    t0: T0,
    screenStartAt: T0,
    cameraStartAt: T0 + 0.4,
    startEventLagMs: { screen: 210, camera: 15 },
    frame: { w: 1920, h: 1080 },
    clockOffsetMs: 0,
    clockRttMs: 0.1,
    screenMime: 'video/webm;codecs=vp9',
    cameraMime: 'video/webm;codecs=vp9,opus',
    screenHasAudio: false,
    cursorHidden: false,
    cameraHasVideo: true,
    cameraHasAudio: true,
    cameraSize: { w: 640, h: 360 },
    ...over
  }
}

const stopInfo = (over: Partial<StopInfo> = {}): StopInfo => ({ endedAt: T0 + 3000, reason: 'user', frame: { w: 1920, h: 1080 }, notes: [], ...over })

/** Eventos do rastreador (relógio do main = renderer + 0): cursor a 120 Hz percorrendo a tela, 2 cliques e 3 teclas. */
function rawEvents(kind: 'screen' | 'window' = 'screen'): RawEvents {
  const raw: RawEvents = { cursor: [], clicks: [], keys: [], windowRects: [] }
  const rect = kind === 'screen' ? SCREEN_SOURCE.rectPx : WINDOW_SOURCE.rectPx
  for (let i = 0; i < 360; i++) {
    const t = T0 - 50 + i * (1000 / 120) // começa 50 ms ANTES do t0 (o rastreador sobe antes do gravador)
    raw.cursor.push(t, rect.x + Math.round((rect.w * (i % 360)) / 360), rect.y + Math.round(rect.h / 2))
  }
  raw.clicks.push({ t: T0 + 500, upT: T0 + 580, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, button: 'left' })
  raw.clicks.push({ t: T0 + 1600, upT: T0 + 1690, x: rect.x + 10, y: rect.y + 10, button: 'right' })
  raw.keys.push(T0 + 800, T0 + 900, T0 + 1000)
  if (kind === 'window') raw.windowRects.push({ t: T0 - 60, frame: rect, client: { ...rect, x: rect.x + 1, y: rect.y + 38, w: rect.w - 2, h: rect.h - 39 } })
  return raw
}

async function feed(world: FakeWorld, files: { screen?: Buffer; camera?: Buffer; mic?: Buffer }): Promise<void> {
  const chunkSize = 200_000
  for (const [kind, buf] of Object.entries(files) as ['screen' | 'camera' | 'mic', Buffer][]) {
    for (let off = 0; off < buf.length; off += chunkSize) await world.service.chunk(kind, buf.subarray(off, off + chunkSize))
  }
}

async function waitDone(world: FakeWorld, timeoutMs = 120_000): Promise<ProcessSnapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const finals = world.emitted.filter((e) => e.channel === 'process:progress' && e.payload.status !== 'running')
    if (finals.length > 0) return finals[finals.length - 1]!.payload as ProcessSnapshot
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('O processamento não terminou a tempo.')
}

function newWorld(over: Partial<Parameters<typeof createFakeWorld>[0]> = {}) {
  const root = join(tmp(), 'projetos')
  const world = createFakeWorld({ root, ffmpeg: ff, ...over })
  return { world, root }
}

async function record(world: FakeWorld, request: RecordRequest, opts: { raw?: RawEvents; pause?: boolean; files?: { screen?: Buffer; camera?: Buffer; mic?: Buffer }; info?: Partial<StartedInfo> } = {}) {
  const prepared = await world.service.prepare(request)
  if (opts.raw) world.trackerResult.raw = opts.raw
  expect(await world.service.countdown()).toBe(true)
  await world.service.go()
  await world.service.started(startedInfo(opts.info))
  await feed(world, opts.files ?? { screen: rawScreen, camera: rawCamera })
  if (opts.pause) {
    await world.service.pause(T0 + 1100)
    await world.service.resume(T0 + 1300)
  }
  const stopped = await world.service.stop(stopInfo())
  return { prepared, stopped }
}

describe('fluxo completo: tela + câmera', () => {
  it('prepara, conta, grava, pausa, para, processa e deixa um projeto válido e uma pasta crua preservada', async () => {
    const { world, root } = newWorld()
    expect(world.service.status().status).toBe('idle')
    const prepared = await world.service.prepare(baseRequest)
    expect(world.service.status().status).toBe('preparing')
    expect(prepared).toMatchObject({ kind: 'screen', sourceName: 'Tela 1', scale: 1.25, nativeSize: { w: 1920, h: 1080 } })
    expect(prepared.folder).toBe('2026-10-04 1500 Gravação')
    expect(existsSync(join(root, prepared.folder, 'raw', 'recording.json'))).toBe(true)
    expect(world.calls).toContain('arm screen:0:0 audio=false')

    world.trackerResult.raw = rawEvents()
    expect(await world.service.countdown()).toBe(true)
    expect(world.service.status().status).toBe('countdown')
    expect(world.calls).toContain('main minimizada')
    await world.service.go()
    expect(world.trackers[0]!.calls).toEqual(['start'])
    await world.service.started(startedInfo())
    expect(world.service.status().status).toBe('recording')
    expect(world.calls).toEqual(expect.arrayContaining(['hotkeys:on', 'bar:show', 'bubble:show']))
    expect(world.service.barState()).toMatchObject({ status: 'recording', hasMic: true, hasCamera: true })

    await feed(world, { screen: rawScreen, camera: rawCamera })
    // bruto em disco já durante a gravação (queda de energia não perde)
    expect(statSync(join(root, prepared.folder, 'raw', 'screen.webm')).size).toBe(rawScreen.length)
    expect(statSync(join(root, prepared.folder, 'raw', 'camera.webm')).size).toBe(rawCamera.length)

    await world.service.pause(T0 + 1100)
    expect(world.service.status().status).toBe('paused')
    expect(world.trackers[0]!.calls).toContain('pause')
    expect(world.service.barState()!.status).toBe('paused')
    await world.service.resume(T0 + 1300)
    expect(world.service.status().status).toBe('recording')
    expect(world.trackers[0]!.calls).toContain('resume')

    const { sessionId } = await world.service.stop(stopInfo())
    expect(sessionId).toBe(prepared.sessionId)
    expect(world.service.status().status).toBe('idle')
    expect(world.calls).toEqual(expect.arrayContaining(['hotkeys:off', 'bar:hide', 'bubble:hide', 'main restaurada', 'disarm']))

    const snap = await waitDone(world)
    expect(snap.status).toBe('done')
    expect(snap.steps.map((s) => s.id)).toEqual(['save', 'screen', 'camera', 'voice', 'thumb', 'project'])
    expect(snap.steps.every((s) => s.status === 'done')).toBe(true)

    const dir = join(root, prepared.folder)
    for (const rel of ['media/screen.mp4', 'media/camera.mp4', 'media/voice.wav', 'media/thumb.jpg', 'events/cursor.jsonl', 'events/clicks.jsonl', 'events/keys.jsonl', 'project.json', 'raw/screen.webm', 'raw/camera.webm', 'raw/recording.json']) {
      expect(existsSync(join(dir, rel)), `falta ${rel}`).toBe(true)
    }
    const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    expect(project.id).toBe(prepared.sessionId)
    expect(project.title).toBe('Gravação 15:00')
    expect(project.createdAt).toBe(new Date(2026, 9, 4, 15, 0, 0).toISOString())
    expect(project.capture).toMatchObject({ kind: 'screen', scale: 1.25, frameSize: { w: 1920, h: 1080 }, cursorHidden: false, sourceName: 'Tela 1' })
    expect(project.capture.boundsPx).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
    expect(project.style.cursor.mode).toBe('real')
    expect(project.sync.screenOffsetMs).toBe(0)
    expect(project.sync.cameraOffsetMs).toBeCloseTo(0.4, 1)
    expect(project.sources.screen).toMatchObject({ path: 'media/screen.mp4', fps: 30, w: 1920, h: 1080 })
    expect(project.sources.camera).toMatchObject({ path: 'media/camera.mp4', fps: 30, w: 640, h: 360 })
    expect(project.sources.voice?.durationMs).toBeGreaterThan(2400)
    expect(Math.abs(project.sources.screen!.durationMs - 2800)).toBeLessThan(400)

    // Eventos: a pausa (1100-1300) tirou 200 ms; as amostras antes do t0 foram descartadas.
    const cursor = readFileSync(join(dir, 'events/cursor.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { t: number; x: number; y: number })
    expect(cursor[0]!.t).toBeGreaterThanOrEqual(0) // o que veio antes do t0 foi descartado
    expect(cursor[0]!.t).toBeLessThan(10)
    // Nem as amostras de antes do t0 (50 ms) nem as da pausa (200 ms) entram: o tempo fica contínuo
    // (salto de ~8 ms entre vizinhas em todo lugar, inclusive onde ficava a pausa).
    for (let i = 1; i < cursor.length; i++) expect(cursor[i]!.t - cursor[i - 1]!.t, `salto em ${cursor[i - 1]!.t}`).toBeLessThan(20)
    const expectedSamples = Math.round((2950 - 200) / (1000 / 120))
    expect(Math.abs(cursor.length - expectedSamples)).toBeLessThanOrEqual(3)
    expect(Math.abs(cursor[cursor.length - 1]!.t - 2750)).toBeLessThan(12)
    const clicks = readFileSync(join(dir, 'events/clicks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { t: number; x: number; y: number; button: string; upT?: number })
    expect(clicks).toHaveLength(2)
    expect(clicks[0]).toMatchObject({ t: 500, x: 0.5, y: 0.5, button: 'left', upT: 580 })
    expect(clicks[1]!.t).toBe(1600 - 200) // depois da pausa de 200 ms
    const keys = readFileSync(join(dir, 'events/keys.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as object)
    expect(keys).toEqual([{ t: 800 }, { t: 900 }, { t: 1000 }])
    const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { recordedMs: number; pauses: unknown[]; processedAt: string }
    expect(manifest.recordedMs).toBe(3000 - 200)
    expect(manifest.pauses).toEqual([{ start: T0 + 1100, end: T0 + 1300 }])
    expect(manifest.processedAt).toBeTruthy()
  }, 120_000)

  it('captura de janela: window.jsonl, retângulo da moldura, nome da janela', async () => {
    const { world, root } = newWorld({ source: WINDOW_SOURCE })
    const { prepared } = await record(world, { ...baseRequest, sourceId: 'window:4242:0', mode: 'screen', cameraId: null }, { raw: rawEvents('window'), files: { screen: rawScreen, mic: rawMic }, info: { cameraHasVideo: false, cameraSize: null, frame: { w: 984, h: 742 } } })
    expect(prepared.kind).toBe('window')
    const snap = await waitDone(world)
    expect(snap.status, snap.error?.message).toBe('done')
    const dir = join(root, prepared.folder)
    const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    expect(project.capture).toMatchObject({ kind: 'window', sourceName: 'Janela de teste', frameSize: { w: 984, h: 742 } })
    expect(project.capture.boundsPx).toEqual(WINDOW_SOURCE.rectPx)
    expect(existsSync(join(dir, 'events/window.jsonl'))).toBe(true)
    const rects = readFileSync(join(dir, 'events/window.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { t: number; x: number; w: number })
    expect(rects[0]).toMatchObject({ t: 0, x: 400, w: 984 })
  }, 120_000)

  it('só a tela, sem microfone: não há passos de câmera nem de voz', async () => {
    const { world, root } = newWorld()
    const { prepared } = await record(world, { ...baseRequest, mode: 'screen', cameraId: null, micId: null }, { files: { screen: rawScreen }, info: { cameraStartAt: null, cameraMime: null, cameraHasVideo: false, cameraHasAudio: false, cameraSize: null } })
    const snap = await waitDone(world)
    expect(snap.steps.map((s) => s.id)).toEqual(['save', 'screen', 'thumb', 'project'])
    expect(snap.status).toBe('done')
    const project = parseProject(readFileSync(join(root, prepared.folder, 'project.json'), 'utf8'))
    expect(project.sources.camera).toBeUndefined()
    expect(project.sources.voice).toBeUndefined()
  }, 120_000)

  it('só a câmera: sem eventos de mouse, captura padrão, câmera e voz no projeto', async () => {
    const { world, root } = newWorld()
    const { prepared } = await record(world, { ...baseRequest, mode: 'camera', sourceId: null }, { files: { camera: rawCamera }, info: { screenStartAt: null, screenMime: null, frame: null } })
    expect(world.calls.some((c) => c.startsWith('arm'))).toBe(false)
    expect(world.trackers).toHaveLength(0) // não há tela para rastrear
    const snap = await waitDone(world)
    expect(snap.status, snap.error?.message).toBe('done')
    expect(snap.steps.map((s) => s.id)).toEqual(['save', 'camera', 'voice', 'thumb', 'project'])
    const dir = join(root, prepared.folder)
    const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    expect(project.sources.screen).toBeUndefined()
    expect(project.sources.camera?.path).toBe('media/camera.mp4')
    expect(project.sources.voice?.path).toBe('media/voice.wav')
    expect(existsSync(join(dir, 'events'))).toBe(false)
  }, 120_000)

  it('câmera que sumiu antes de começar: sobra só a voz em raw/mic.webm e o passo da câmera não existe', async () => {
    const { world, root } = newWorld()
    const { prepared } = await record(world, baseRequest, { files: { screen: rawScreen, mic: rawMic }, info: { cameraHasVideo: false, cameraSize: null, cameraMime: 'audio/webm;codecs=opus' } })
    const snap = await waitDone(world)
    expect(snap.status, snap.error?.message).toBe('done')
    expect(snap.steps.map((s) => s.id)).toEqual(['save', 'screen', 'voice', 'thumb', 'project'])
    const dir = join(root, prepared.folder)
    expect(existsSync(join(dir, 'raw/mic.webm'))).toBe(true)
    expect(existsSync(join(dir, 'raw/camera.webm'))).toBe(false)
    const project = parseProject(readFileSync(join(dir, 'project.json'), 'utf8'))
    expect(project.sources.camera).toBeUndefined()
    expect(project.sources.voice?.path).toBe('media/voice.wav')
  }, 120_000)
})

describe('falhas visíveis, nunca silenciosas', () => {
  it('passo que falha: snapshot "failed" com o motivo, o bruto fica, e "tentar de novo" retoma sem refazer o que já deu certo', async () => {
    const { world, root } = newWorld({ env: { TOMADA_TEST_FAIL_STEP: 'voice' } })
    const { prepared } = await record(world, baseRequest, { raw: rawEvents() })
    const failed = await waitDone(world)
    expect(failed.status).toBe('failed')
    expect(failed.error?.step).toBe('voice')
    expect(failed.error?.message).toContain('Falha simulada')
    expect(failed.steps.find((s) => s.id === 'voice')!.status).toBe('error')
    expect(failed.steps.find((s) => s.id === 'screen')!.status).toBe('done')
    expect(failed.steps.find((s) => s.id === 'thumb')!.status).toBe('pending')

    const dir = join(root, prepared.folder)
    expect(existsSync(join(dir, 'raw/screen.webm'))).toBe(true) // bruto preservado
    expect(existsSync(join(dir, 'raw/camera.webm'))).toBe(true)
    expect(existsSync(join(dir, 'project.json'))).toBe(false) // nada com cara de pronto
    expect(readdirSync(join(dir, 'media')).filter((n) => n.endsWith('.parcial'))).toEqual([])
    const screenMtime = statSync(join(dir, 'media/screen.mp4')).mtimeMs

    world.emitted.length = 0
    await world.service.retry(prepared.sessionId)
    const done = await waitDone(world)
    expect(done.status, done.error?.message).toBe('done')
    expect(done.steps.every((s) => s.status === 'done')).toBe(true)
    expect(statSync(join(dir, 'media/screen.mp4')).mtimeMs).toBe(screenMtime) // o passo da tela NÃO refez
    expect(parseProject(readFileSync(join(dir, 'project.json'), 'utf8')).sources.voice).toBeDefined()
  }, 180_000)

  it('erro de escrita em disco vira aviso e rejeição; a gravação ainda para e preserva o que tem', async () => {
    const { world, root } = newWorld()
    const prepared = await world.service.prepare(baseRequest)
    expect(await world.service.countdown()).toBe(true)
    await world.service.go()
    await world.service.started(startedInfo())
    // O disco "some". `rm` de fs/promises, não `rmSync`: no Windows o `rmSync` recursivo não apaga
    // (e não avisa) quando o próprio caminho tem acento, e a pasta é "… Gravação".
    await rm(join(root, prepared.folder, 'raw'), { recursive: true, force: true })
    expect(existsSync(join(root, prepared.folder, 'raw'))).toBe(false)
    await expect(world.service.chunk('screen', rawScreen.subarray(0, 1000))).rejects.toThrow(/gravar em disco/)
    const notice = world.emitted.find((e) => e.channel === 'record:notice' && (e.payload as { kind?: string }).kind === 'error')
    expect(notice?.payload).toMatchObject({ kind: 'error' })
    expect((notice!.payload as { detail?: string }).detail).toBeTruthy()
    await expect(world.service.chunk('screen', rawScreen.subarray(0, 1000))).rejects.toThrow() // continua falhando, sem engolir
    const noticeCount = world.emitted.filter((e) => e.channel === 'record:notice' && (e.payload as { kind?: string }).kind === 'error').length
    expect(noticeCount).toBe(1) // o aviso aparece uma vez só
    await world.service.stop(stopInfo({ reason: 'write-error' }))
    const snap = await waitDone(world)
    expect(snap.status).toBe('failed') // sem bruto, o processamento diz por quê
    expect(snap.error?.message).toBeTruthy()
    const manifest = JSON.parse(readFileSync(join(root, prepared.folder, 'raw/recording.json'), 'utf8')) as { notes: string[]; stopReason: string }
    expect(manifest.stopReason).toBe('write-error')
    expect(manifest.notes.join(' ')).toContain('Erro de escrita')
  }, 120_000)

  it('rastreador que não sobe: aviso visível, anotado no projeto, e o vídeo é gravado mesmo assim', async () => {
    const { world, root } = newWorld({ failTracker: true })
    const { prepared } = await record(world, baseRequest)
    const notice = world.emitted.find((e) => e.channel === 'record:notice' && (e.payload as { kind?: string }).kind === 'error')
    expect(notice?.payload).toMatchObject({ kind: 'error' })
    expect((notice!.payload as { text: string }).text).toContain('rastreador')
    const snap = await waitDone(world)
    expect(snap.status, snap.error?.message).toBe('done')
    expect(snap.notes.join(' ')).toContain('rastreador')
    const dir = join(root, prepared.folder)
    expect(readFileSync(join(dir, 'events/cursor.jsonl'), 'utf8')).toBe('')
    const manifest = JSON.parse(readFileSync(join(dir, 'raw/recording.json'), 'utf8')) as { notes: string[] }
    expect(manifest.notes.some((n) => n.includes('rastreador'))).toBe(true)
  }, 120_000)

  it('ffmpeg ausente: prepare recusa com o que fazer', async () => {
    const { world } = newWorld({ ffmpeg: null })
    await expect(world.service.prepare(baseRequest)).rejects.toThrow(/ffmpeg/)
    expect(world.service.status().status).toBe('idle')
  })

  it('pedido inválido, fonte que sumiu e gravação dupla são recusados com mensagem clara', async () => {
    const { world } = newWorld()
    await expect(world.service.prepare({ ...baseRequest, sourceId: null })).rejects.toThrow(/Escolha a tela/)
    await expect(world.service.prepare({ ...baseRequest, cameraId: null })).rejects.toThrow(/Escolha uma câmera/)
    await expect(world.service.prepare({ ...baseRequest, sourceId: 'window:999:0' })).rejects.toThrow(/não existe mais/)
    expect(world.service.status().status).toBe('idle')
    await world.service.prepare(baseRequest)
    await expect(world.service.prepare(baseRequest)).rejects.toThrow(/andamento/)
    await world.service.abort('teste')
  })

  it('não grava outra enquanto a anterior ainda processa', async () => {
    const { world } = newWorld({ env: { TOMADA_TEST_STEP_DELAY_MS: '400' } })
    await record(world, baseRequest)
    await expect(world.service.prepare(baseRequest)).rejects.toThrow(/processamento/)
    const snap = await waitDone(world)
    expect(snap.status).toBe('done')
    await world.service.prepare(baseRequest) // agora pode
    await world.service.abort('teste')
  }, 120_000)
})

describe('cancelar e descartar', () => {
  it('contagem cancelada (Esc): nada fica em disco, a janela volta', async () => {
    const { world, root } = newWorld()
    const prepared = await world.service.prepare(baseRequest)
    world.countdownResult.value = false
    expect(await world.service.countdown()).toBe(false)
    expect(world.service.status().status).toBe('idle')
    expect(existsSync(join(root, prepared.folder))).toBe(false)
    expect(world.calls).toContain('main restaurada')
    expect(world.calls).toContain('disarm')
    expect(world.trackers).toHaveLength(0)
  })

  it('descartar no meio da gravação: pasta vai para a Lixeira, atalhos e barra saem, pedaço atrasado é ignorado', async () => {
    const { world, root } = newWorld()
    const prepared = await world.service.prepare(baseRequest)
    expect(await world.service.countdown()).toBe(true)
    await world.service.go()
    await world.service.started(startedInfo())
    await world.service.chunk('screen', rawScreen.subarray(0, 50_000))
    await world.service.abort('descartada pelo usuário')
    expect(world.trashed).toEqual([join(root, prepared.folder)])
    expect(existsSync(join(root, prepared.folder))).toBe(false)
    expect(world.service.status().status).toBe('idle')
    expect(world.calls).toEqual(expect.arrayContaining(['hotkeys:off', 'bar:hide', 'main restaurada']))
    await expect(world.service.chunk('screen', rawScreen.subarray(0, 100))).resolves.toBeUndefined() // chegou depois: ignorado
    // e dá para gravar de novo
    await world.service.prepare(baseRequest)
    await world.service.abort('teste')
  })

  it('parar sem estar gravando é erro; pausar fora de hora é ignorado', async () => {
    const { world } = newWorld()
    await expect(world.service.stop(stopInfo())).rejects.toThrow(/Não há gravação/)
    await world.service.pause(1)
    await world.service.resume(2)
    expect(world.service.status().status).toBe('idle')
  })

  it('comandos da barra e dos atalhos chegam à janela que grava', async () => {
    const { world } = newWorld()
    world.service.command('pause', 'bar') // sem gravação: ignorado
    expect(world.emitted.filter((e) => e.channel === 'record:command')).toHaveLength(0)
    await world.service.prepare(baseRequest)
    world.service.command('stop', 'hotkey')
    expect(world.emitted.find((e) => e.channel === 'record:command')?.payload).toEqual({ cmd: 'stop', source: 'hotkey' })
    await world.service.abort('teste')
  })
})
