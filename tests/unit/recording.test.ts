import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECORD_PREFS,
  buildEvents,
  cameraBitrate,
  chooseCaptureRect,
  defaultRecordingTitle,
  effectiveMode,
  elapsedMs,
  estimateClockOffset,
  isPaused,
  levelToMeter,
  normalizeIntervals,
  normalizeRecordPrefs,
  pausedBefore,
  peakFromBytes,
  pickRecorderMime,
  recordingFolderName,
  recordRequestSchema,
  resolveScreenRect,
  screenBitrate,
  smoothMeter,
  toJsonLines,
  toRecordingTime,
  uniqueName,
  validateRecordRequest,
  type RawEvents,
  type RecordRequest
} from '@shared/recording'

describe('preferências da tela Gravar', () => {
  it('sem nada guardado = padrões', () => {
    expect(normalizeRecordPrefs(undefined)).toEqual(DEFAULT_RECORD_PREFS)
    expect(normalizeRecordPrefs({})).toEqual(DEFAULT_RECORD_PREFS)
    expect(normalizeRecordPrefs(null)).toEqual(DEFAULT_RECORD_PREFS)
    expect(normalizeRecordPrefs([1, 2])).toEqual(DEFAULT_RECORD_PREFS)
  })

  it('o que está certo é mantido; o que está ruim volta ao padrão, campo a campo', () => {
    const prefs = normalizeRecordPrefs({ mode: 'camera', fps: 60, cameraId: 'cam-1', micId: 7, systemAudio: 'sim', noiseSuppression: false })
    expect(prefs.mode).toBe('camera')
    expect(prefs.fps).toBe(60)
    expect(prefs.cameraId).toBe('cam-1')
    expect(prefs.micId).toBeNull() // número não é id de dispositivo
    expect(prefs.systemAudio).toBe(false) // "sim" não é booleano
    expect(prefs.noiseSuppression).toBe(false)
    expect(prefs.echoCancellation).toBe(false) // padrão: eco desligado
  })

  it('qps só aceita 30 ou 60', () => {
    expect(normalizeRecordPrefs({ fps: 24 }).fps).toBe(30)
    expect(normalizeRecordPrefs({ fps: 60 }).fps).toBe(60)
    expect(normalizeRecordPrefs({ mode: 'tudo' }).mode).toBe('screen-camera')
  })

  it('estilo da câmera: padrão Quadro ao lado, lembra o Apresentador e valor ruim volta ao padrão', () => {
    expect(DEFAULT_RECORD_PREFS.cameraStyle).toBe('side-by-side')
    expect(normalizeRecordPrefs({}).cameraStyle).toBe('side-by-side')
    expect(normalizeRecordPrefs({ cameraStyle: 'presenter' }).cameraStyle).toBe('presenter')
    expect(normalizeRecordPrefs({ cameraStyle: 'green-screen' }).cameraStyle).toBe('side-by-side')
    expect(normalizeRecordPrefs({ cameraStyle: 7 }).cameraStyle).toBe('side-by-side')
  })

  it('o pedido de gravação aceita o estilo da câmera (opcional) e recusa valor desconhecido', () => {
    const base = { mode: 'screen-camera', sourceId: 'screen:0:0', fps: 30, cameraId: 'c', micId: 'm', systemAudio: false, showBubble: true, hideCursor: true }
    expect(recordRequestSchema.safeParse(base).success).toBe(true)
    expect(recordRequestSchema.safeParse({ ...base, cameraStyle: 'presenter' }).success).toBe(true)
    expect(recordRequestSchema.safeParse({ ...base, cameraStyle: 'side-by-side' }).success).toBe(true)
    expect(recordRequestSchema.safeParse({ ...base, cameraStyle: 'tella' }).success).toBe(false)
  })

  it('padrão do som: filtros do navegador desligados, cursor escondido pedido', () => {
    expect(DEFAULT_RECORD_PREFS.noiseSuppression).toBe(false)
    expect(DEFAULT_RECORD_PREFS.echoCancellation).toBe(false)
    expect(DEFAULT_RECORD_PREFS.hideCursor).toBe(true)
    expect(DEFAULT_RECORD_PREFS.fps).toBe(30)
  })
})

describe('modo efetivo e validação do pedido', () => {
  it('"tela e câmera" sem câmera vira "só a tela"; "só a câmera" sem câmera é inválido', () => {
    expect(effectiveMode({ mode: 'screen-camera', cameraId: 'c' })).toBe('screen-camera')
    expect(effectiveMode({ mode: 'screen-camera', cameraId: null })).toBe('screen')
    expect(effectiveMode({ mode: 'screen', cameraId: 'c' })).toBe('screen')
    expect(effectiveMode({ mode: 'camera', cameraId: 'c' })).toBe('camera')
    expect(effectiveMode({ mode: 'camera', cameraId: null })).toBeNull()
  })

  const base: RecordRequest = { mode: 'screen-camera', sourceId: 'screen:0:0', fps: 30, cameraId: 'c', micId: 'm', systemAudio: false, showBubble: true, hideCursor: true }

  it('os três modos válidos passam; faltando fonte ou câmera, não', () => {
    expect(validateRecordRequest(base)).toBeNull()
    expect(validateRecordRequest({ ...base, mode: 'screen', cameraId: null })).toBeNull()
    expect(validateRecordRequest({ ...base, mode: 'camera', sourceId: null })).toBeNull()
    expect(validateRecordRequest({ ...base, sourceId: null })).toBe('no-source')
    expect(validateRecordRequest({ ...base, cameraId: null })).toBe('no-camera')
    expect(validateRecordRequest({ ...base, mode: 'camera', cameraId: null })).toBe('no-camera')
  })

  it('o esquema da IPC recusa lixo', () => {
    expect(recordRequestSchema.safeParse(base).success).toBe(true)
    expect(recordRequestSchema.safeParse({ ...base, fps: 24 }).success).toBe(false)
    expect(recordRequestSchema.safeParse({ ...base, mode: 'x' }).success).toBe(false)
    expect(recordRequestSchema.safeParse({ ...base, sourceId: 5 }).success).toBe(false)
  })
})

describe('pausas: desconto do tempo parado', () => {
  const pauses = [
    { start: 2000, end: 3000 },
    { start: 5000, end: 5500 }
  ]

  it('toRecordingTime: antes do t0 e dentro de pausa não existem; depois, desconta o que já foi pausado', () => {
    const t0 = 1000
    expect(toRecordingTime(900, t0, pauses)).toBeNull() // antes do t0
    expect(toRecordingTime(1000, t0, pauses)).toBe(0)
    expect(toRecordingTime(1500, t0, pauses)).toBe(500)
    expect(toRecordingTime(2000, t0, pauses)).toBeNull() // exatamente no início da pausa
    expect(toRecordingTime(2500, t0, pauses)).toBeNull()
    expect(toRecordingTime(3000, t0, pauses)).toBe(1000) // a pausa acabou: 3000 − 1000 − 1000 pausado
    expect(toRecordingTime(4000, t0, pauses)).toBe(2000)
    expect(toRecordingTime(5200, t0, pauses)).toBeNull()
    expect(toRecordingTime(6000, t0, pauses)).toBe(3500) // 6000 − 1000 − 1000 − 500
  })

  it('pausedBefore conta pausa em andamento só até o instante', () => {
    expect(pausedBefore(2500, pauses)).toBe(500)
    expect(pausedBefore(10_000, pauses)).toBe(1500)
    expect(pausedBefore(1000, pauses)).toBe(0)
    expect(isPaused(2999, pauses)).toBe(true)
    expect(isPaused(3000, pauses)).toBe(false)
  })

  it('sem pausas o tempo é só abs − t0', () => {
    expect(toRecordingTime(1234.5, 1000, [])).toBeCloseTo(234.5, 6)
  })

  it('normalizeIntervals ordena, funde sobrepostos e joga fora vazios e inválidos', () => {
    expect(
      normalizeIntervals([
        { start: 50, end: 80 },
        { start: 10, end: 30 },
        { start: 25, end: 40 },
        { start: 5, end: 5 },
        { start: Number.NaN, end: 9 }
      ])
    ).toEqual([
      { start: 10, end: 40 },
      { start: 50, end: 80 }
    ])
  })

  it('elapsedMs (cronômetro da barra): para durante a pausa em andamento', () => {
    const t0 = 1000
    expect(elapsedMs(1500, t0, [])).toBe(500)
    expect(elapsedMs(4000, t0, [{ start: 2000, end: 3000 }])).toBe(2000)
    // pausado desde 2000, agora é 9000: o cronômetro fica em 1000
    expect(elapsedMs(9000, t0, [], 2000)).toBe(1000)
    expect(elapsedMs(9000, t0, [{ start: 1200, end: 1400 }], 2000)).toBe(800)
    expect(elapsedMs(900, t0, [])).toBe(0)
  })
})

describe('relógio: diferença entre renderer e main', () => {
  it('vale o ping de MENOR ida e volta, no ponto médio', () => {
    const r = estimateClockOffset([
      { sentAt: 100, receivedAt: 120, remoteNow: 400 }, // rtt 20, offset 400−110 = 290
      { sentAt: 200, receivedAt: 202, remoteNow: 491 }, // rtt 2, offset 491−201 = 290
      { sentAt: 300, receivedAt: 340, remoteNow: 700 } // rtt 40, offset 700−320 = 380 (fila)
    ])
    expect(r.rttMs).toBe(2)
    expect(r.offsetMs).toBe(290)
  })

  it('ping inválido é ignorado; sem nenhum válido, erro', () => {
    expect(estimateClockOffset([{ sentAt: 10, receivedAt: 5, remoteNow: 0 }, { sentAt: 1, receivedAt: 3, remoteNow: 12 }]).offsetMs).toBe(10)
    expect(() => estimateClockOffset([])).toThrow()
    expect(() => estimateClockOffset([{ sentAt: 10, receivedAt: 5, remoteNow: 0 }])).toThrow()
  })
})

describe('casar monitor e display (DPI misto)', () => {
  // Esta máquina: notebook 1920×1080 a 125% (origem 0,0) e externo 2560×1080 a 100% acima dele.
  const monitors = [
    { rect: { x: 0, y: 0, w: 1920, h: 1080 }, primary: true },
    { rect: { x: -319, y: -1080, w: 2560, h: 1080 }, primary: false }
  ]

  it('o display do Electron em pixels físicos casa exatamente com o monitor do Win32', () => {
    const r = resolveScreenRect({ rectPx: { x: -319, y: -1080, w: 2560, h: 1080 } }, monitors)
    expect(r).toMatchObject({ rect: { x: -319, y: -1080, w: 2560, h: 1080 }, source: 'win32', distance: 0 })
    expect(r.note).toBeUndefined()
    expect(resolveScreenRect({ rectPx: { x: 0, y: 0, w: 1920, h: 1080 } }, monitors).rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })

  it('divergência pequena: vale o monitor do Win32 (verdade física) e avisa', () => {
    const r = resolveScreenRect({ rectPx: { x: -318, y: -1080, w: 2560, h: 1080 } }, monitors)
    expect(r.rect).toEqual({ x: -319, y: -1080, w: 2560, h: 1080 })
    expect(r.source).toBe('win32')
    expect(r.distance).toBe(1)
    expect(r.note).toContain('divergem')
  })

  it('sem monitor parecido (ou sem lista): vale o do Electron, com aviso', () => {
    const far = resolveScreenRect({ rectPx: { x: 5000, y: 5000, w: 800, h: 600 } }, monitors)
    expect(far.source).toBe('electron')
    expect(far.rect).toEqual({ x: 5000, y: 5000, w: 800, h: 600 })
    expect(far.note).toContain('Nenhum monitor')
    const none = resolveScreenRect({ rectPx: { x: 0, y: 0, w: 1920, h: 1080 } }, [])
    expect(none.source).toBe('electron')
    expect(none.note).toContain('não listou')
  })
})

describe('qual retângulo o quadro mostra', () => {
  const frame = { x: 158, y: 125, w: 1134, h: 792 }
  const client = { x: 159, y: 163, w: 1132, h: 753 }

  it('janela de outro programa: o quadro é a moldura inteira (casa por tamanho, não por ordem)', () => {
    const c = chooseCaptureRect({ w: 1134, h: 792 }, [
      { name: 'client', rect: client },
      { name: 'frame', rect: frame }
    ])
    expect(c.source).toBe('frame')
    expect(c.rect).toEqual({ x: 158, y: 125, w: 1134, h: 792 })
    expect(c.sizeMismatch).toBeNull()
  })

  it('só a área de cliente (janela do próprio processo): origem do cliente', () => {
    const c = chooseCaptureRect({ w: 1132, h: 753 }, [
      { name: 'frame', rect: frame },
      { name: 'client', rect: client }
    ])
    expect(c.source).toBe('client')
    expect(c.rect.x).toBe(159)
  })

  it('tolera 2 px; fora disso, escolhe o mais próximo e registra a diferença (usa o quadro real)', () => {
    const near = chooseCaptureRect({ w: 1135, h: 791 }, [{ name: 'frame', rect: frame }])
    expect(near.sizeMismatch).toEqual({ dw: 1, dh: -1 })
    expect(near.rect).toEqual({ x: 158, y: 125, w: 1135, h: 791 })
    const far = chooseCaptureRect({ w: 1076, h: 752 }, [
      { name: 'client', rect: client },
      { name: 'frame', rect: frame }
    ])
    expect(far.source).toBe('client') // diferenças de (−56, −1) contra (−58, −40): a área de cliente é a mais próxima
    expect(far.sizeMismatch).toEqual({ dw: -56, dh: -1 })
    expect(far.rect).toEqual({ x: 159, y: 163, w: 1076, h: 752 })
  })

  it('quadro desconhecido: usa o primeiro candidato como está', () => {
    const c = chooseCaptureRect(null, [{ name: 'monitor', rect: { x: 0, y: 0, w: 1920, h: 1080 } }])
    expect(c.rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
    expect(c.sizeMismatch).toBeNull()
    expect(() => chooseCaptureRect(null, [])).toThrow()
  })
})

describe('eventos brutos → cursor.jsonl, clicks.jsonl, keys.jsonl', () => {
  const emptyRaw = (): RawEvents => ({ cursor: [], clicks: [], keys: [], windowRects: [] })
  const screenRect = { x: -319, y: -1080, w: 2560, h: 1080 } // monitor acima do principal

  it('tela: normaliza 0..1 pelo retângulo físico (origem negativa) e marca o que está fora', () => {
    const raw = emptyRaw()
    // main = renderer + 5 (mainToRenderer = −5): t0 do renderer = 1000
    raw.cursor.push(1005, -319, -1080) // t = 0, canto superior esquerdo
    raw.cursor.push(1105, 961, -540) // t = 100, centro
    raw.cursor.push(1205, 5000, 0) // t = 200, fora (à direita, abaixo)
    const built = buildEvents({ raw, kind: 'screen', screenRect, frame: { w: 2560, h: 1080 }, t0: 1000, mainToRenderer: -5, pauses: [] })
    expect(built.cursor).toEqual([
      { t: 0, x: 0, y: 0 },
      { t: 100, x: 0.5, y: 0.5 },
      { t: 200, x: 1, y: 1, out: true }
    ])
    expect(built.stats.outsideCursor).toBe(1)
    expect(built.boundsPx).toEqual(screenRect)
    expect(built.windowRects).toEqual([])
    expect(built.sizeMismatch).toBeNull()
  })

  it('amostras antes do t0 e dentro de pausas não entram; o tempo depois da pausa é descontado', () => {
    const raw = emptyRaw()
    for (const abs of [990, 1000, 1500, 2100, 2900, 3000, 3500]) raw.cursor.push(abs, screenRect.x, screenRect.y)
    const built = buildEvents({
      raw,
      kind: 'screen',
      screenRect,
      frame: { w: 2560, h: 1080 },
      t0: 1000,
      mainToRenderer: 0,
      pauses: [{ start: 2000, end: 3000 }]
    })
    expect(built.cursor.map((c) => c.t)).toEqual([0, 500, 1000, 1500]) // 1000, 1500, 3000→1000, 3500→1500
    expect(built.stats.droppedOutside).toBe(3) // 990 (antes do t0), 2100 e 2900 (pausa)
  })

  it('cliques: ordenados, com upT, fora da área marcados, dentro de pausa descartados', () => {
    const raw = emptyRaw()
    raw.clicks.push({ t: 2200, upT: 2290, x: 100, y: -500, button: 'left' }) // dentro da pausa
    raw.clicks.push({ t: 1500, upT: 1590, x: 961, y: -540, button: 'right' })
    raw.clicks.push({ t: 1200, upT: 1260, x: 99999, y: 0, button: 'left' }) // fora
    raw.clicks.push({ t: 3100, x: 961, y: -540, button: 'middle' }) // sem upT (parou apertado)
    const built = buildEvents({ raw, kind: 'screen', screenRect, frame: { w: 2560, h: 1080 }, t0: 1000, mainToRenderer: 0, pauses: [{ start: 2000, end: 3000 }] })
    expect(built.clicks).toEqual([
      { t: 200, x: 1, y: 1, button: 'left', upT: 260, out: true },
      { t: 500, x: 0.5, y: 0.5, button: 'right', upT: 590 },
      { t: 1100, x: 0.5, y: 0.5, button: 'middle' }
    ])
  })

  it('teclas: só o instante, ordenado e sem pausas — nunca qual tecla', () => {
    const raw = emptyRaw()
    raw.keys.push(1700, 1100, 2500, 3200)
    const built = buildEvents({ raw, kind: 'screen', screenRect, frame: null, t0: 1000, mainToRenderer: 0, pauses: [{ start: 2000, end: 3000 }] })
    expect(built.keys).toEqual([{ t: 100 }, { t: 700 }, { t: 1200 }])
    for (const k of built.keys) expect(Object.keys(k)).toEqual(['t'])
  })

  it('janela: a área acompanha a janela quando ela se mexe, e vale o tamanho do quadro real', () => {
    const raw = emptyRaw()
    const f1 = { x: 100, y: 100, w: 1134, h: 792 }
    const c1 = { x: 101, y: 138, w: 1132, h: 753 }
    raw.windowRects.push({ t: 900, frame: f1, client: c1 })
    raw.windowRects.push({ t: 2000, frame: { ...f1, x: 400 }, client: { ...c1, x: 401 } }) // a janela andou 300 px
    raw.cursor.push(1000, 100 + 567, 100 + 396) // centro da janela na posição 1
    raw.cursor.push(2500, 400 + 567, 100 + 396) // centro da janela na posição 2
    const built = buildEvents({ raw, kind: 'window', screenRect: null, frame: { w: 1134, h: 792 }, t0: 1000, mainToRenderer: 0, pauses: [] })
    expect(built.rectSource).toBe('frame')
    expect(built.cursor).toEqual([
      { t: 0, x: 0.5, y: 0.5 },
      { t: 1500, x: 0.5, y: 0.5 }
    ])
    expect(built.windowRects).toEqual([
      { t: 0, x: 100, y: 100, w: 1134, h: 792 },
      { t: 1000, x: 400, y: 100, w: 1134, h: 792 }
    ])
    expect(built.boundsPx).toEqual({ x: 100, y: 100, w: 1134, h: 792 })
  })

  it('janela com quadro do tamanho da área de cliente usa a origem do cliente', () => {
    const raw = emptyRaw()
    raw.windowRects.push({ t: 900, frame: { x: 100, y: 100, w: 1134, h: 792 }, client: { x: 101, y: 138, w: 1132, h: 753 } })
    raw.cursor.push(1000, 101 + 566, 138 + 376.5)
    const built = buildEvents({ raw, kind: 'window', screenRect: null, frame: { w: 1132, h: 753 }, t0: 1000, mainToRenderer: 0, pauses: [] })
    expect(built.rectSource).toBe('client')
    expect(built.cursor[0]).toEqual({ t: 0, x: 0.5, y: 0.5 })
  })

  it('tela com quadro diferente do monitor: normaliza pelo quadro real e registra a diferença', () => {
    const raw = emptyRaw()
    raw.cursor.push(1000, 0, 0)
    const built = buildEvents({ raw, kind: 'screen', screenRect: { x: 0, y: 0, w: 1920, h: 1080 }, frame: { w: 1920, h: 1078 }, t0: 1000, mainToRenderer: 0, pauses: [] })
    expect(built.sizeMismatch).toEqual({ dw: 0, dh: -2 })
    expect(built.boundsPx).toEqual({ x: 0, y: 0, w: 1920, h: 1078 })
  })

  it('toJsonLines: uma linha por item, com quebra de linha final; vazio = nada', () => {
    expect(toJsonLines([{ t: 1 }, { t: 2 }])).toBe('{"t":1}\n{"t":2}\n')
    expect(toJsonLines([])).toBe('')
  })
})

describe('codec e taxa de bits', () => {
  it('H.264 primeiro; sem ele, VP9; depois VP8; nada aceito = null', () => {
    const only = (...ok: string[]) => (m: string) => ok.includes(m)
    const v = { video: true, audio: false }
    expect(pickRecorderMime(only('video/webm;codecs=h264', 'video/webm;codecs=vp9'), v)).toBe('video/webm;codecs=h264')
    expect(pickRecorderMime(only('video/webm;codecs=vp9', 'video/webm;codecs=vp8'), v)).toBe('video/webm;codecs=vp9')
    expect(pickRecorderMime(only('video/webm;codecs=vp8'), v)).toBe('video/webm;codecs=vp8')
    expect(pickRecorderMime(only(), v)).toBeNull()
  })

  it('com áudio pede a variante com opus; só áudio usa audio/webm', () => {
    const all = () => true
    expect(pickRecorderMime(all, { video: true, audio: true })).toBe('video/webm;codecs=h264,opus')
    expect(pickRecorderMime(all, { video: false, audio: true })).toBe('audio/webm;codecs=opus')
    expect(pickRecorderMime((m) => m === 'audio/webm', { video: false, audio: true })).toBe('audio/webm')
  })

  it('taxa de bits da tela: 1080p60 ≈ 16 Mbps, mínimo 8, teto 60', () => {
    expect(screenBitrate({ w: 1920, h: 1080 }, 60)).toBeGreaterThan(15_500_000)
    expect(screenBitrate({ w: 1920, h: 1080 }, 60)).toBeLessThan(16_500_000)
    expect(screenBitrate({ w: 1920, h: 1080 }, 30)).toBe(8_087_040) // 1920×1080×30×0,13
    expect(screenBitrate({ w: 640, h: 360 }, 30)).toBe(8_000_000)
    expect(screenBitrate({ w: 7680, h: 4320 }, 60)).toBe(60_000_000)
  })

  it('taxa de bits da câmera fica entre 2,5 e 16 Mbps', () => {
    expect(cameraBitrate({ w: 640, h: 360 }, 30)).toBe(2_500_000)
    expect(cameraBitrate({ w: 1920, h: 1080 }, 30)).toBeGreaterThan(7_900_000)
    expect(cameraBitrate({ w: 3840, h: 2160 }, 60)).toBe(16_000_000)
  })
})

describe('nomes de pasta e título', () => {
  const d = new Date(2026, 9, 4, 15, 7) // 04/10/2026 15:07 (hora local)

  it('título e pasta no padrão do projeto (AAAA-MM-DD HHmm título)', () => {
    expect(defaultRecordingTitle(d)).toBe('Gravação 15:07')
    expect(recordingFolderName(d)).toBe('2026-10-04 1507 Gravação')
  })

  it('caracteres proibidos no Windows saem do nome; vazio volta a "Gravação"', () => {
    expect(recordingFolderName(d, 'a/b:c*d?e"f<g>h|i')).toBe('2026-10-04 1507 a b c d e f g h i')
    expect(recordingFolderName(d, '  ')).toBe('2026-10-04 1507 Gravação')
  })

  it('uniqueName acrescenta (2), (3)… até achar nome livre', () => {
    const taken = new Set(['x', 'x (2)'])
    expect(uniqueName('y', (n) => taken.has(n))).toBe('y')
    expect(uniqueName('x', (n) => taken.has(n))).toBe('x (3)')
  })
})

describe('medidor de nível do microfone', () => {
  it('pico de bytes de 8 bits (centro 128)', () => {
    expect(peakFromBytes([128, 128, 128])).toBe(0)
    expect(peakFromBytes([128, 255, 0])).toBe(1)
    expect(peakFromBytes([128, 192])).toBeCloseTo(0.5, 6)
    expect(peakFromBytes([])).toBe(0)
  })

  it('escala em dB: 0 dB cheio, −60 dB vazio, −6 dB ≈ 0,9', () => {
    expect(levelToMeter(1)).toBe(1)
    expect(levelToMeter(0)).toBe(0)
    expect(levelToMeter(0.001)).toBe(0)
    expect(levelToMeter(0.5)).toBeCloseTo(0.9, 1)
    expect(levelToMeter(0.01)).toBeCloseTo(1 / 3, 5) // −40 dB
  })

  it('ataque instantâneo e queda suave', () => {
    expect(smoothMeter(0.2, 0.8, 50)).toBe(0.8)
    expect(smoothMeter(0.8, 0.1, 100)).toBeCloseTo(0.64, 5) // cai 1,6/s × 0,1 s
    expect(smoothMeter(0.3, 0.29, 1000)).toBe(0.29) // nunca abaixo do nível real
  })
})
