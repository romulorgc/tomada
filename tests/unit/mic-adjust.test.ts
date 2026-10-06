import { describe, expect, it } from 'vitest'
import { adjustMicVolume, type AdjustDeps, type AdjustProgress } from '../../src/renderer/recording/mic-adjust'
import { clampDb, type MicVolumeInfo } from '../../src/shared/mic-level'

/** Aparelho simulado: o pico da fala responde 1 dB por dB de ganho e satura em 0 dBFS. */
function rig(opts: { db: number; minDb: number; maxDb: number; stepDb?: number; peakAtStartDbfs: number; speech?: boolean; reject?: boolean; deaf?: boolean }) {
  const startDb = opts.db
  let db = opts.db
  const sets: number[] = []
  const progress: AdjustProgress[] = []
  const info = (): MicVolumeInfo => ({ name: 'Microfone (USB PnP Sound Device)', scalar: (db - opts.minDb) / (opts.maxDb - opts.minDb || 1), db, minDb: opts.minDb, maxDb: opts.maxDb, stepDb: opts.stepDb ?? 0.1875, muted: false, isDefault: true })
  let cancelled = false
  const deps: AdjustDeps = {
    label: 'Padrão - Microfone (USB PnP Sound Device) (08bb:2902)',
    readVolume: async () => info(),
    setVolumeDb: async (_label, value) => { sets.push(value); if (opts.reject) return null; db = clampDb(value, opts); return info() },
    waitForSpeech: async () => opts.speech !== false,
    // `deaf`: o ganho muda, mas o pico medido não (aparelho que não obedece ao volume do Windows).
    peakSince: () => Math.min(0, opts.peakAtStartDbfs + (opts.deaf ? 0 : db - startDb)),
    resetMeter: () => undefined,
    sleep: async () => undefined,
    isCancelled: () => cancelled,
    onProgress: (p) => progress.push(p)
  }
  return { deps, sets, progress, state: info, cancel: () => { cancelled = true } }
}

describe('Ajustar sozinho (volume de entrada do Windows)', () => {
  it('CASO REAL: 0% (0 dB, faixa 0 a +23,8) com fala em -38 dBFS sobe ao máximo e a fala chega a -14 dBFS em 2 passos', async () => {
    const r = rig({ db: 0, minDb: 0, maxDb: 23.8125, peakAtStartDbfs: -38 })
    const out = await adjustMicVolume(r.deps)
    expect(out.kind).toBe('done')
    if (out.kind !== 'done') return
    expect(out.steps).toBe(2)
    expect(out.peakDbfs).toBeCloseTo(-14.19, 1)
    expect(r.sets).toEqual([23.8125])
    expect(r.state().scalar).toBe(1)
    // O progresso conta a escuta e a aplicação de cada passo.
    expect(r.progress.map((p) => `${p.step}:${p.phase}`)).toEqual(['1:listening', '1:applying', '2:listening', '2:applying'])
  })

  it('aparelho de faixa larga chega ao alvo (-12 dBFS) sem nunca estourar', async () => {
    const r = rig({ db: -50, minDb: -96, maxDb: 30, stepDb: 0.5, peakAtStartDbfs: -52 })
    const out = await adjustMicVolume(r.deps)
    expect(out.kind).toBe('done')
    if (out.kind === 'done') expect(out.peakDbfs).toBeCloseTo(-12, 1)
    expect(r.sets.length).toBe(1)
  })

  it('pico que já estourou baixa o ganho', async () => {
    const r = rig({ db: 20, minDb: 0, maxDb: 24, stepDb: 1, peakAtStartDbfs: -0.4 })
    const out = await adjustMicVolume(r.deps)
    expect(out.kind).toBe('done')
    expect(r.sets[0]!).toBeLessThan(20)
  })

  it('volume já bom: não muda nada', async () => {
    const r = rig({ db: 12, minDb: 0, maxDb: 24, stepDb: 1, peakAtStartDbfs: -13 })
    expect((await adjustMicVolume(r.deps)).kind).toBe('done')
    expect(r.sets).toEqual([])
  })

  it('sem fala: diz que não ouviu a voz e não mexe no volume', async () => {
    const r = rig({ db: 0, minDb: 0, maxDb: 24, peakAtStartDbfs: -60, speech: false })
    expect(await adjustMicVolume(r.deps)).toMatchObject({ kind: 'failed', reason: 'no-speech' })
    expect(r.sets).toEqual([])
  })

  it('já no máximo e ainda baixo: diz que o aparelho chegou ao limite', async () => {
    const r = rig({ db: 23.8125, minDb: 0, maxDb: 23.8125, peakAtStartDbfs: -40 })
    expect(await adjustMicVolume(r.deps)).toMatchObject({ kind: 'failed', reason: 'at-max' })
  })

  it('o Windows recusa a mudança: falha com o motivo, sem laço', async () => {
    const r = rig({ db: 0, minDb: 0, maxDb: 24, peakAtStartDbfs: -40, reject: true })
    expect(await adjustMicVolume(r.deps)).toMatchObject({ kind: 'failed', reason: 'rejected' })
    expect(r.sets).toHaveLength(1)
  })

  it('aparelho que muda o ganho mas não a fala não prende o ajuste: para no máximo e avisa', async () => {
    const r = rig({ db: 0, minDb: 0, maxDb: 24, peakAtStartDbfs: -40, deaf: true })
    const out = await adjustMicVolume(r.deps)
    expect(out.kind).toBe('failed')
    expect(r.sets.length).toBeLessThanOrEqual(2)
    if (out.kind === 'failed') expect(['at-max', 'no-convergence']).toContain(out.reason)
  })

  it('leitura impossível (fora do Windows ou aparelho não achado): não suportado', async () => {
    const r = rig({ db: 0, minDb: 0, maxDb: 24, peakAtStartDbfs: -40 })
    expect(await adjustMicVolume({ ...r.deps, readVolume: async () => null })).toMatchObject({ kind: 'failed', reason: 'unsupported' })
  })

  it('cancelar interrompe antes de mexer no volume', async () => {
    const r = rig({ db: 0, minDb: 0, maxDb: 24, peakAtStartDbfs: -40 })
    r.cancel()
    expect(await adjustMicVolume(r.deps)).toMatchObject({ kind: 'failed', reason: 'cancelled' })
    expect(r.sets).toEqual([])
  })
})
