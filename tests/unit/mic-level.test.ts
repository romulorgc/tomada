import { describe, expect, it } from 'vitest'
import {
  MIC_PEAK_TARGET_DBFS, assessMicLevel, microphoneBaseName, pickMicrophone, planVolumeStep, volumePercent, type MicVolumeInfo
} from '@shared/mic-level'

const device = (patch: Partial<MicVolumeInfo> = {}): MicVolumeInfo => ({ name: 'Microfone (USB PnP Sound Device)', scalar: 0, db: 0, minDb: 0, maxDb: 23.8125, stepDb: 0.1875, muted: false, isDefault: true, ...patch })

describe('decisão do nível do microfone antes de gravar', () => {
  it('CASO REAL (06/10/2026): fone USB com volume de entrada em 0% e fala em -38 dBFS de pico avisa e oferece o ajuste', () => {
    const windows = device()
    const a = assessMicLevel({ peakDbfs: -38, observedMs: 2000, windows })
    expect(a.status).toBe('too-low')
    expect(a.reasons).toEqual(['windows-minimum', 'speech-low'])
    expect(a.canAdjust).toBe(true)
  })

  it('volume do Windows no mínimo avisa mesmo antes de a pessoa falar', () => {
    const a = assessMicLevel({ peakDbfs: null, observedMs: 300, windows: device() })
    expect(a).toMatchObject({ status: 'too-low', reasons: ['windows-minimum'], canAdjust: true })
  })

  it('fala abaixo de -24 dBFS de pico avisa depois de 2 s; silêncio da sala não vira aviso', () => {
    const windows = device({ scalar: 0.5, db: 12 })
    expect(assessMicLevel({ peakDbfs: -30, observedMs: 2500, windows }).status).toBe('too-low')
    expect(assessMicLevel({ peakDbfs: -30, observedMs: 1000, windows }).status).toBe('listening')
    expect(assessMicLevel({ peakDbfs: -70, observedMs: 5000, windows }).status).toBe('listening')
    expect(assessMicLevel({ peakDbfs: -15, observedMs: 2500, windows }).status).toBe('ok')
    expect(assessMicLevel({ peakDbfs: -24, observedMs: 2500, windows }).status).toBe('ok')
  })

  it('já no ganho máximo e ainda baixo: avisa, mas não oferece o botão', () => {
    const a = assessMicLevel({ peakDbfs: -35, observedMs: 3000, windows: device({ scalar: 1, db: 23.8125 }) })
    expect(a).toMatchObject({ status: 'too-low', reasons: ['speech-low'], canAdjust: false })
  })

  it('sem leitura do Windows, a fala baixa ainda avisa (sem botão); mudo e estouro têm estados próprios', () => {
    expect(assessMicLevel({ peakDbfs: -40, observedMs: 3000, windows: null })).toMatchObject({ status: 'too-low', canAdjust: false })
    expect(assessMicLevel({ peakDbfs: -10, observedMs: 3000, windows: device({ muted: true }) }).status).toBe('muted')
    expect(assessMicLevel({ peakDbfs: -0.2, observedMs: 3000, windows: device({ scalar: 1, db: 23.8 }) }).status).toBe('clipping')
  })

  it('um aparelho sem faixa de ganho (0 a 0,5 dB) no 0% não acusa "volume no mínimo"', () => {
    expect(assessMicLevel({ peakDbfs: -10, observedMs: 3000, windows: device({ maxDb: 0.5 }) }).status).toBe('ok')
  })
})

describe('ajuste sozinho do volume de entrada', () => {
  /** Aparelho simulado: o pico responde 1 dB por dB de ganho e satura em 0 dBFS. */
  function converge(start: { db: number; minDb: number; maxDb: number; stepDb: number }, peakAtStart: number, maxSteps = 6): { db: number; peak: number; steps: number; clipped: boolean; action: string } {
    let db = start.db, peak = peakAtStart, steps = 0, clipped = false
    const measure = (): number => Math.min(0, peakAtStart + (db - start.db))
    for (; steps < maxSteps; steps++) {
      peak = measure()
      if (peak >= -1) clipped = true
      const step = planVolumeStep({ currentDb: db, peakDbfs: peak, ...start })
      if (step.action !== 'set') return { db, peak, steps, clipped, action: step.action }
      db = step.nextDb
    }
    return { db, peak: measure(), steps, clipped, action: 'limit' }
  }

  it('CASO REAL: de 0 dB (0%) e pico -38 dBFS sobe ao máximo do aparelho (+23,8 dB) e a fala chega a -14 dBFS', () => {
    const r = converge({ db: 0, minDb: 0, maxDb: 23.8125, stepDb: 0.1875 }, -38)
    expect(r.db).toBeCloseTo(23.8125, 4)
    expect(r.peak).toBeCloseTo(-14.1875, 3)
    expect(r.action).toBe('done')
    expect(r.clipped).toBe(false)
  })

  it('aparelho com faixa larga (-96 a +30 dB) para no alvo, em poucos passos', () => {
    const r = converge({ db: -40, minDb: -96, maxDb: 30, stepDb: 0.5 }, -45)
    expect(r.peak).toBeCloseTo(MIC_PEAK_TARGET_DBFS, 3)
    expect(r.steps).toBeLessThanOrEqual(2)
    expect(r.action).toBe('done')
  })

  it('pico já bom não mexe; estouro perto de 0 dBFS baixa o ganho em vez de subir', () => {
    expect(planVolumeStep({ currentDb: 10, peakDbfs: -13, minDb: 0, maxDb: 24, stepDb: 1 })).toEqual({ action: 'done' })
    const down = planVolumeStep({ currentDb: 20, peakDbfs: -0.5, minDb: 0, maxDb: 24, stepDb: 1 })
    expect(down).toEqual({ action: 'set', nextDb: 8.5 })
  })

  it('sem fala não ajusta; no limite do aparelho diz para que lado', () => {
    expect(planVolumeStep({ currentDb: 0, peakDbfs: -70, minDb: 0, maxDb: 24, stepDb: 1 })).toEqual({ action: 'no-speech' })
    expect(planVolumeStep({ currentDb: 0, peakDbfs: null, minDb: 0, maxDb: 24, stepDb: 1 })).toEqual({ action: 'no-speech' })
    expect(planVolumeStep({ currentDb: 24, peakDbfs: -40, minDb: 0, maxDb: 24, stepDb: 1 })).toEqual({ action: 'at-limit', direction: 'up' })
    expect(planVolumeStep({ currentDb: 0, peakDbfs: -2, minDb: 0, maxDb: 24, stepDb: 1 })).toEqual({ action: 'at-limit', direction: 'down' })
  })

  it('nunca pede ganho fora da faixa do aparelho, qualquer que seja a medida', () => {
    for (const peak of [-54, -45, -38, -30, -20, -8, -2, -0.5]) for (const db of [-96, -20, 0, 12, 30]) {
      const step = planVolumeStep({ currentDb: db, peakDbfs: peak, minDb: -96, maxDb: 30, stepDb: 0.5 })
      if (step.action === 'set') { expect(step.nextDb).toBeGreaterThanOrEqual(-96); expect(step.nextDb).toBeLessThanOrEqual(30) }
    }
  })
})

describe('nome e escolha do aparelho', () => {
  it('tira o prefixo do alias e o sufixo de USB que o Chromium acrescenta', () => {
    expect(microphoneBaseName('Padrão - Microfone (USB PnP Sound Device) (08bb:2902)')).toBe('Microfone (USB PnP Sound Device)')
    expect(microphoneBaseName('Microfone (EMEET SmartCam C60E 4K) (328f:00f3)')).toBe('Microfone (EMEET SmartCam C60E 4K)')
    expect(microphoneBaseName('Default - Grupo de microfones (2- Tecnologia Intel® Smart Sound para microfones digitais)')).toBe('Grupo de microfones (2- Tecnologia Intel® Smart Sound para microfones digitais)')
    expect(microphoneBaseName('  Microfone\u0000\u001f   X ')).toBe('Microfone X')
  })

  it('acha o aparelho pelo nome e cai no padrão do Windows quando o rótulo é o alias', () => {
    const devices = [device({ isDefault: false, name: 'Microfone (EMEET SmartCam C60E 4K)' }), device()]
    expect(pickMicrophone(devices, 'Microfone (EMEET SmartCam C60E 4K) (328f:00f3)')?.name).toBe('Microfone (EMEET SmartCam C60E 4K)')
    expect(pickMicrophone(devices, 'Padrão - Microfone (USB PnP Sound Device) (08bb:2902)')?.name).toBe('Microfone (USB PnP Sound Device)')
    expect(pickMicrophone(devices, 'default')?.isDefault).toBe(true)
    expect(pickMicrophone(devices, 'Microfone Fantasma')).toBeNull()
    expect(pickMicrophone([], 'Padrão - X')).toBeNull()
  })

  it('mostra o volume em porcentagem', () => {
    expect(volumePercent(0)).toBe(0)
    expect(volumePercent(0.848904)).toBe(85)
    expect(volumePercent(1.4)).toBe(100)
  })
})
