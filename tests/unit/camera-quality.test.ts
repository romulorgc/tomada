import { describe, expect, it } from 'vitest'
import {
  CAMERA_PROFILES,
  CAMERA_PROBE_MIN_FPS,
  CAMERA_WARN_FPS,
  cameraCaptureInfoSchema,
  cameraCaptureReport,
  cameraFallbackNote,
  cameraLadder,
  cameraRecordBitrate,
  cameraVideoConstraints,
  framesPerSecond,
  lowCameraFpsNote,
  probeAccepts,
  walkCameraLadder,
  type CameraCaptureInfo
} from '@shared/camera-quality'
import { deviceCaptureConstraints } from '@shared/capture-devices'
import { normalizeRecordPrefs, recordRequestSchema } from '@shared/recording'

describe('degraus da câmera', () => {
  it('Máxima tenta o 4K e cai no 1080p; Alta fica no 1080p', () => {
    expect(cameraLadder('max').map((p) => p.id)).toEqual(['uhd', 'fhd'])
    expect(cameraLadder('high').map((p) => p.id)).toEqual(['fhd'])
  })

  it('o 4K pede 30 qps com teto; o 1080p pede o modo de 60 (em pouca luz a EMEET entrega ~30 nele e 15 no modo de 30)', () => {
    expect(cameraVideoConstraints(CAMERA_PROFILES.uhd)).toEqual({ width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30, max: 30 } })
    expect(cameraVideoConstraints(CAMERA_PROFILES.fhd)).toEqual({ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } })
  })

  it('calibração e gravação pedem o mesmo modo: o degrau seguro por padrão, o escolhido na gravação', () => {
    const prefs = { echoCancellation: false, noiseSuppression: false }
    expect(deviceCaptureConstraints('cam', 'mic', prefs).video).toEqual({ deviceId: { exact: 'cam' }, ...cameraVideoConstraints(CAMERA_PROFILES.fhd) })
    expect(deviceCaptureConstraints('cam', 'mic', prefs, CAMERA_PROFILES.uhd).video).toEqual({ deviceId: { exact: 'cam' }, ...cameraVideoConstraints(CAMERA_PROFILES.uhd) })
    expect(deviceCaptureConstraints(null, 'mic', prefs).video).toBe(false)
  })
})

describe('taxa de bits da câmera', () => {
  it('4K a 30 ≈ 45 Mbps; 1080p ≈ 16 Mbps (20 no modo de 60); sempre entre 4 e 50', () => {
    expect(cameraRecordBitrate({ w: 3840, h: 2160 }, 30)).toBeGreaterThan(44_000_000)
    expect(cameraRecordBitrate({ w: 3840, h: 2160 }, 30)).toBeLessThanOrEqual(50_000_000)
    expect(cameraRecordBitrate({ w: 1920, h: 1080 }, 30)).toBeGreaterThan(15_500_000)
    expect(cameraRecordBitrate({ w: 1920, h: 1080 }, 30)).toBeLessThan(17_000_000)
    expect(cameraRecordBitrate({ w: 1920, h: 1080 }, 60)).toBeGreaterThan(19_500_000)
    expect(cameraRecordBitrate({ w: 3840, h: 2160 }, 60)).toBe(50_000_000)
    expect(cameraRecordBitrate({ w: 640, h: 360 }, 30)).toBe(4_000_000)
  })
})

describe('qps medidos', () => {
  it('conta intervalos, não quadros', () => {
    expect(framesPerSecond(31, 1000)).toBe(30)
    expect(framesPerSecond(16, 1000)).toBe(15)
    expect(framesPerSecond(1, 1000)).toBe(0)
    expect(framesPerSecond(30, 0)).toBe(0)
  })

  it('a sondagem recusa o que cai abaixo de 28 qps', () => {
    expect(probeAccepts(30.1)).toBe(true)
    expect(probeAccepts(CAMERA_PROBE_MIN_FPS)).toBe(true)
    expect(probeAccepts(24)).toBe(false)
    expect(probeAccepts(15)).toBe(false)
  })
})

describe('escolha do degrau na abertura', () => {
  const measure = (table: Record<string, number | null | Error>) => async (profile: (typeof CAMERA_PROFILES)['uhd']) => {
    const value = table[profile.id]
    if (value instanceof Error) throw value
    return { width: profile.width, height: profile.height, fps: value ?? null }
  }

  it('fica no 4K quando a trilha prova 30 qps', async () => {
    const r = await walkCameraLadder('max', measure({ uhd: 30.1, fhd: 30 }))
    expect(r.profile.id).toBe('uhd')
    expect(r.info).toMatchObject({ quality: 'max', profile: 'uhd', width: 3840, height: 2160, probeFps: 30.1 })
    expect(r.info.attempts).toHaveLength(1)
    expect(cameraFallbackNote(r.info)).toBeNull()
  })

  it('cai para o 1080p quando o 4K chega a 15 qps (a câmera reduz sozinha em pouca luz) e diz por quê', async () => {
    const r = await walkCameraLadder('max', measure({ uhd: 15, fhd: 30.2 }))
    expect(r.profile.id).toBe('fhd')
    expect(r.info.attempts.map((a) => [a.profile, a.accepted])).toEqual([['uhd', false], ['fhd', true]])
    const note = cameraFallbackNote(r.info)!
    expect(note).toContain('1080p em vez de 4K')
    expect(note).toContain('15 qps')
    expect(note).toContain('Alta (1080p)')
  })

  it('o último degrau sempre vale, mesmo lento (melhor gravar do que não gravar: o aviso do fim fala)', async () => {
    const r = await walkCameraLadder('max', measure({ uhd: 15, fhd: 20 }))
    expect(r.profile.id).toBe('fhd')
    expect(r.info.probeFps).toBe(20)
  })

  it('Alta nunca tenta o 4K', async () => {
    const seen: string[] = []
    const r = await walkCameraLadder('high', async (p) => { seen.push(p.id); return { width: 1920, height: 1080, fps: 30 } })
    expect(seen).toEqual(['fhd'])
    expect(r.info.quality).toBe('high')
  })

  it('degrau que não abre vira tentativa registrada e o seguinte é tentado; se o último não abre, o erro sobe', async () => {
    const r = await walkCameraLadder('max', measure({ uhd: new Error('NotReadableError'), fhd: 30 }))
    expect(r.profile.id).toBe('fhd')
    expect(r.info.attempts[0]).toMatchObject({ profile: 'uhd', fps: 0, accepted: false })
    await expect(walkCameraLadder('high', measure({ fhd: new Error('NotReadableError') }))).rejects.toThrow('NotReadableError')
  })

  it('sem como medir (fps nulo) aceita o degrau', async () => {
    const r = await walkCameraLadder('max', measure({ uhd: null }))
    expect(r.profile.id).toBe('uhd')
    expect(r.info.probeFps).toBe(0)
  })
})

describe('câmera que abriu menor que o degrau', () => {
  const uhd: CameraCaptureInfo = { quality: 'max', profile: 'uhd', width: 640, height: 360, probeFps: 30, attempts: [{ profile: 'uhd', width: 640, height: 360, fps: 30, accepted: true }] }

  it('o aparelho oferece 4K mas a trilha veio em 640×360: outra janela ou programa estava com a câmera (diz o quê fazer)', () => {
    const note = cameraFallbackNote({ ...uhd, maxWidth: 3840 })!
    expect(note).toContain('640×360')
    expect(note).toContain('3840×2160')
    expect(note).toContain('outro programa ou janela')
  })

  it('câmera que NÃO oferece 4K (webcam de 720p) não gera esse aviso', () => {
    expect(cameraFallbackNote({ ...uhd, width: 1280, height: 720, maxWidth: 1280 })).toBeNull()
    expect(cameraFallbackNote(uhd)).toBeNull()
  })

  it('o relatório do projeto junta o aviso de tamanho e o de poucos qps', () => {
    const r = cameraCaptureReport({ fps: 15, width: 640, height: 360 }, { ...uhd, maxWidth: 3840, probeFps: 15 })
    expect(r.warning).toContain('outro programa ou janela')
    expect(r.warning).toContain('15,0 qps')
  })
})

describe('aviso de poucos quadros por segundo', () => {
  const info: CameraCaptureInfo = { quality: 'max', profile: 'fhd', width: 1920, height: 1080, probeFps: 15, attempts: [] }

  it('abaixo de 24 qps avisa, com o número, o tamanho, o motivo e o que fazer', () => {
    const note = lowCameraFpsNote({ fps: 15.04, width: 1920, height: 1080 }, info)!
    expect(note).toContain('15,0 qps')
    expect(note).toContain('1920×1080')
    expect(note).toContain('pouca luz')
    expect(note).toContain('acenda uma luz')
    expect(note).toContain('Alta (1080p)')
  })

  it('a abertura tinha medido certo: o motivo é a queda durante a gravação (luz mudou ou computador sobrecarregado)', () => {
    const note = lowCameraFpsNote({ fps: 18, width: 3840, height: 2160 }, { ...info, probeFps: 30 })!
    expect(note).toContain('durante a gravação')
  })

  it('a partir de 24 qps não avisa; sem medida também não', () => {
    expect(lowCameraFpsNote({ fps: CAMERA_WARN_FPS, width: 1920, height: 1080 }, info)).toBeNull()
    expect(lowCameraFpsNote({ fps: 29.9, width: 1920, height: 1080 }, null)).toBeNull()
    expect(lowCameraFpsNote({ fps: 0, width: 0, height: 0 }, null)).toBeNull()
  })

  it('o relatório do projeto leva a medida e o aviso só quando há aviso (gravação antiga, sem info, também funciona)', () => {
    expect(cameraCaptureReport({ fps: 29.97, width: 3840, height: 2160 }, { ...info, profile: 'uhd', probeFps: 30 })).toEqual({ quality: 'max', profile: 'uhd', width: 3840, height: 2160, fps: 29.97, probeFps: 30 })
    const slow = cameraCaptureReport({ fps: 15.04, width: 1920, height: 1080 }, null)
    expect(slow.warning).toContain('15,0 qps')
    expect(slow).toMatchObject({ quality: 'max', profile: 'fhd', probeFps: 0 })
  })
})

describe('o que vem do disco e da interface', () => {
  it('o formato do manifesto confere; lixo é recusado', () => {
    const ok: CameraCaptureInfo = { quality: 'max', profile: 'uhd', width: 3840, height: 2160, probeFps: 30, attempts: [{ profile: 'uhd', width: 3840, height: 2160, fps: 30, accepted: true }] }
    expect(cameraCaptureInfoSchema.safeParse(ok).success).toBe(true)
    expect(cameraCaptureInfoSchema.safeParse({ ...ok, profile: '8k' }).success).toBe(false)
    expect(cameraCaptureInfoSchema.safeParse({ ...ok, width: -1 }).success).toBe(false)
    expect(cameraCaptureInfoSchema.safeParse('texto').success).toBe(false)
  })

  it('a preferência "Qualidade da câmera" vale Máxima por padrão, lembra Alta e recusa lixo', () => {
    expect(normalizeRecordPrefs({}).cameraQuality).toBe('max')
    expect(normalizeRecordPrefs({ cameraQuality: 'high' }).cameraQuality).toBe('high')
    expect(normalizeRecordPrefs({ cameraQuality: '8k' }).cameraQuality).toBe('max')
  })

  it('o pedido de gravação aceita a qualidade (opcional) e recusa valor desconhecido', () => {
    const base = { mode: 'camera', sourceId: null, fps: 30, cameraId: 'cam', micId: null, systemAudio: false, showBubble: false, hideCursor: false }
    expect(recordRequestSchema.safeParse(base).success).toBe(true)
    expect(recordRequestSchema.safeParse({ ...base, cameraQuality: 'high' }).success).toBe(true)
    expect(recordRequestSchema.safeParse({ ...base, cameraQuality: 'ultra' }).success).toBe(false)
  })
})
