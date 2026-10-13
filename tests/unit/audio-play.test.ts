import { describe, expect, it } from 'vitest'
import { AudioWatchdog, DEFAULT_WATCHDOG, classifyPlayError, playFailureText, type AudioProbe, type WatchAction } from '@shared/audio-play'

const abort = (): Error => Object.assign(new Error('The play() request was interrupted by a call to pause().'), { name: 'AbortError' })

describe('classifyPlayError: a interrupção do play() por um pause() do próprio motor não é falha', () => {
  it('o AbortError do log de 09/10 é "interrompido" (esperado), pelo nome ou só pela frase', () => {
    expect(classifyPlayError(abort())).toMatchObject({ kind: 'interrupted', name: 'AbortError' })
    expect(classifyPlayError(new Error('The play() request was interrupted by a call to pause().')).kind).toBe('interrupted')
    expect(classifyPlayError(new Error('The play() request was interrupted by a new load request.')).kind).toBe('interrupted')
    expect(classifyPlayError({ name: 'AbortError', message: 'x' }).kind).toBe('interrupted')
  })

  it('o que de fato impede o som é falha, com o motivo', () => {
    const blocked = classifyPlayError(Object.assign(new Error('play() failed because the user didn\'t interact with the document first.'), { name: 'NotAllowedError' }))
    expect(blocked.kind).toBe('blocked')
    expect(playFailureText(blocked)).toContain('sem um clique seu')
    const unsupported = classifyPlayError(Object.assign(new Error('The element has no supported sources.'), { name: 'NotSupportedError' }))
    expect(unsupported.kind).toBe('unsupported')
    expect(playFailureText(unsupported)).toContain('não abre')
    expect(classifyPlayError(new TypeError('boom'))).toMatchObject({ kind: 'other', name: 'TypeError' })
    expect(playFailureText(classifyPlayError('texto solto'))).toContain('texto solto')
    expect(classifyPlayError(undefined).kind).toBe('other')
    expect(classifyPlayError(null).kind).toBe('other')
  })
})

describe('AudioWatchdog: o áudio devia tocar e não toca → tenta de novo e AVISA, em vez de ficar mudo', () => {
  /** Roda o vigia quadro a quadro (16 ms): `state(t)` descreve o áudio no instante `t`. Devolve as ações que não são "nada". */
  function run(totalMs: number, state: (t: number) => Partial<AudioProbe>, watch = new AudioWatchdog()): { t: number; action: WatchAction }[] {
    const out: { t: number; action: WatchAction }[] = []
    for (let t = 0; t <= totalMs; t += 16) {
      const probe: AudioProbe = { now: t, wantSound: true, paused: false, ended: false, seeking: false, hasError: false, currentTimeS: t / 1000, ...state(t) }
      const action = watch.check(probe)
      if (action.kind !== 'none') out.push({ t, action })
    }
    return out
  }

  it('áudio tocando normalmente: nunca diz nada', () => {
    expect(run(10_000, () => ({}))).toEqual([])
  })

  it('o motor segurou o relógio (pausou o áudio de propósito por 300 ms) e depois voltou: nada (o prazo de tolerância é maior)', () => {
    const actions = run(3000, (t) => (t >= 1000 && t < 1300 ? { paused: true, currentTimeS: 1 } : { currentTimeS: t < 1000 ? t / 1000 : (t - 300) / 1000 }))
    expect(actions).toEqual([])
  })

  it('o usuário pausou (o motor não quer som): nada, por mais tempo que dure', () => {
    expect(run(60_000, () => ({ wantSound: false, paused: true, currentTimeS: 3 }))).toEqual([])
  })

  it('devia tocar e continua parado: tenta de novo 3 vezes (a cada 0,4 s) e então AVISA uma vez só, com o motivo', () => {
    const actions = run(4000, () => ({ paused: true, currentTimeS: 2 }))
    expect(actions.map((a) => a.action.kind)).toEqual(['retry', 'retry', 'retry', 'warn'])
    expect(actions.slice(0, 3).map((a) => (a.action as { attempt: number }).attempt)).toEqual([1, 2, 3])
    const warn = actions[3]!.action
    expect(warn).toMatchObject({ kind: 'warn', reason: 'paused' })
    expect((warn as { text: string }).text).toContain('sem som')
    expect((warn as { text: string }).text).toContain('exportado não é afetado')
    // o aviso chega em ~1,6 s (3 tentativas de 0,4 s + a última espera)
    expect(actions[3]!.t).toBeLessThan(2000)
  })

  it('travou (tocando, mas o relógio do áudio não anda): tenta de novo e avisa que o som parou', () => {
    const actions = run(8000, () => ({ paused: false, currentTimeS: 5 }))
    expect(actions.map((a) => a.action.kind)).toEqual(['retry', 'retry', 'retry', 'warn'])
    expect(actions[0]!.action).toMatchObject({ reason: 'stalled' })
    expect(actions[3]!.action).toMatchObject({ kind: 'warn', reason: 'stalled' })
  })

  it('depois do aviso, quando o áudio volta a andar, o aviso sai (uma vez) e a contagem recomeça', () => {
    const watch = new AudioWatchdog()
    const stuck = run(2500, () => ({ paused: true, currentTimeS: 2 }), watch)
    expect(stuck.at(-1)!.action.kind).toBe('warn')
    expect(watch.warning).toBe(true)
    const t0 = 2500
    const back: { t: number; action: WatchAction }[] = []
    for (let t = t0 + 16; t < t0 + 1000; t += 16) {
      const a = watch.check({ now: t, wantSound: true, paused: false, ended: false, seeking: false, hasError: false, currentTimeS: 2 + (t - t0) / 1000 })
      if (a.kind !== 'none') back.push({ t, action: a })
    }
    expect(back.map((a) => a.action.kind)).toEqual(['clear'])
    expect(watch.warning).toBe(false)
  })

  it('busca, erro do elemento e fim do arquivo reiniciam a conta e nunca viram aviso do vigia', () => {
    expect(run(5000, () => ({ seeking: true, paused: true }))).toEqual([])
    expect(run(5000, () => ({ hasError: true, paused: true }))).toEqual([])
    expect(run(5000, () => ({ ended: true, paused: true }))).toEqual([])
  })

  it('as opções do padrão: tolerância de 0,4 s parado e 1,2 s travado, 3 tentativas', () => {
    expect(DEFAULT_WATCHDOG).toEqual({ graceMs: 400, stallMs: 1200, maxRetries: 3 })
  })
})
