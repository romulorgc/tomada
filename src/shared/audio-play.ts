/**
 * O áudio da prévia "não tocou" (F3, item 4). Código puro: sem DOM, sem Node (o motor, `renderer/editor/engine.ts`, dá os fatos).
 *
 * O que o log de 09/10 mostrou, três vezes: `play() request was interrupted by a call to pause()`. O motor chama `pause()` no áudio de
 * propósito (segura o relógio enquanto o vídeo busca, cancela o cruzamento de uma emenda, o usuário pausa) e o `play()` que ainda estava
 * pendente rejeita com `AbortError`. Isso NÃO é falha: quem pausou sabe. O motor reportava como "O áudio da prévia não tocou", a pílula
 * do transporte ficava em aviso até o fim da sessão e o log dizia que o áudio tinha falhado, quando ele tocava (ou nem devia tocar).
 * Pior: o que de fato impede o som (`NotAllowedError`, `NotSupportedError`, um laço que nunca volta a chamar `play()`) ficava misturado
 * com esse ruído, e o `.catch(() => undefined)` do laço engolia o resto sem rastro.
 *
 * Aqui: (1) `classifyPlayError` separa a interrupção (esperada) da falha real; (2) `AudioWatchdog` olha o áudio de verdade a cada
 * quadro, e se ele devia estar tocando e não toca (parado, ou o relógio andando e o áudio não) tenta de novo e, esgotadas as tentativas,
 * AVISA com o motivo, em vez de ficar mudo sem dizer nada.
 */

export type PlayFailureKind =
  /** `AbortError`: um `pause()`/`load()` do próprio motor atravessou o `play()`. Esperado; nunca é aviso. */
  | 'interrupted'
  /** `NotAllowedError`: o navegador não deixou tocar (política de autoplay, sem gesto do usuário). */
  | 'blocked'
  /** `NotSupportedError`: a fonte não abre ou o formato não é suportado. */
  | 'unsupported'
  | 'other'

export type PlayFailure = { kind: PlayFailureKind; name: string; message: string }

/** Separa a rejeição de `HTMLMediaElement.play()` em interrupção (esperada) e falha de verdade. */
export function classifyPlayError(err: unknown): PlayFailure {
  const name = typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : 'Error'
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : String((err as { message?: unknown } | null)?.message ?? err)
  // Alguns motores só trazem a frase; o nome é o que decide, a frase é a rede de segurança.
  const interrupted = name === 'AbortError' || /interrupted by a call to pause|interrupted by a new load request/i.test(message)
  const kind: PlayFailureKind = interrupted ? 'interrupted' : name === 'NotAllowedError' ? 'blocked' : name === 'NotSupportedError' ? 'unsupported' : 'other'
  return { kind, name, message }
}

/** A frase que a pílula e o log mostram para uma falha real. */
export function playFailureText(f: PlayFailure, what = 'O áudio da prévia'): string {
  if (f.kind === 'blocked') return `${what} não tocou: o sistema não deixou começar sem um clique seu (${f.name}).`
  if (f.kind === 'unsupported') return `${what} não tocou: o arquivo não abre neste aparelho (${f.name}: ${f.message}).`
  return `${what} não tocou (${f.name}: ${f.message}).`
}

// ---------------------------------------------------------------------------
// Vigia

/** O que o motor sabe do áudio num instante. */
export type AudioProbe = {
  /** Relógio do navegador (ms). */
  now: number
  /** O motor quer som agora: tocando a 1×, sem segurar o relógio para uma busca. */
  wantSound: boolean
  paused: boolean
  ended: boolean
  seeking: boolean
  /** O elemento já deu erro (o `error` do navegador cuida da pílula; o vigia não repete). */
  hasError: boolean
  /** `currentTime` do elemento (s). */
  currentTimeS: number
}

export type WatchdogOptions = {
  /** Parado (`paused`) por tanto tempo com o motor querendo som: chama `play()` de novo. */
  graceMs: number
  /** Tocando (`!paused`) mas sem andar por tanto tempo: o áudio travou. */
  stallMs: number
  /** Depois de tantas tentativas sem som, avisa. */
  maxRetries: number
}

export const DEFAULT_WATCHDOG: WatchdogOptions = { graceMs: 400, stallMs: 1200, maxRetries: 3 }

export type WatchAction =
  | { kind: 'none' }
  /** Chame `play()` no áudio de novo (e conte a tentativa). */
  | { kind: 'retry'; reason: 'paused' | 'stalled'; attempt: number }
  /** Esgotou as tentativas: AVISE (pílula + log) com este motivo. */
  | { kind: 'warn'; reason: 'paused' | 'stalled'; text: string }
  /** O áudio voltou a andar depois de um aviso do vigia: tire o aviso. */
  | { kind: 'clear' }

/**
 * O vigia do áudio da prévia. Sem estado de DOM: o motor passa um `AudioProbe` por quadro e executa a ação devolvida. Só fala quando o
 * motor QUER som (`wantSound`): pausa do usuário, relógio segurado e velocidades que silenciam o áudio nunca disparam nada.
 */
export class AudioWatchdog {
  private pausedSince: number | null = null
  private lastTime = Number.NaN
  private movedAt: number | null = null
  private retries = 0
  private warned = false

  constructor(private readonly opts: WatchdogOptions = DEFAULT_WATCHDOG) {}

  /** O motor parou de querer som, trocou de áudio ou buscou: recomeça a contagem (o aviso do vigia, se houver, fica até o áudio andar). */
  quiet(): void {
    this.pausedSince = null
    this.movedAt = null
    this.lastTime = Number.NaN
    this.retries = 0
  }

  get warning(): boolean {
    return this.warned
  }

  check(p: AudioProbe): WatchAction {
    if (!p.wantSound || p.ended || p.hasError || p.seeking) {
      this.quiet()
      return { kind: 'none' }
    }
    if (p.paused) {
      this.lastTime = Number.NaN
      this.movedAt = null
      this.pausedSince ??= p.now
      if (p.now - this.pausedSince < this.opts.graceMs) return { kind: 'none' }
      if (this.retries < this.opts.maxRetries) {
        this.retries++
        this.pausedSince = p.now
        return { kind: 'retry', reason: 'paused', attempt: this.retries }
      }
      return this.warn('paused')
    }
    this.pausedSince = null
    const moved = Number.isFinite(this.lastTime) && Math.abs(p.currentTimeS - this.lastTime) > 0.001
    this.lastTime = p.currentTimeS
    if (moved || this.movedAt === null) {
      this.movedAt = p.now
      if (moved && this.warned) {
        this.warned = false
        this.retries = 0
        return { kind: 'clear' }
      }
      if (moved) this.retries = 0
      return { kind: 'none' }
    }
    if (p.now - this.movedAt < this.opts.stallMs) return { kind: 'none' }
    if (this.retries < this.opts.maxRetries) {
      this.retries++
      this.movedAt = p.now
      return { kind: 'retry', reason: 'stalled', attempt: this.retries }
    }
    return this.warn('stalled')
  }

  private warn(reason: 'paused' | 'stalled'): WatchAction {
    if (this.warned) return { kind: 'none' }
    this.warned = true
    const text =
      reason === 'paused'
        ? 'O áudio da prévia não começou a tocar depois de várias tentativas: o vídeo segue sem som. O arquivo exportado não é afetado.'
        : 'O áudio da prévia travou: a imagem segue e o som parou. O arquivo exportado não é afetado.'
    return { kind: 'warn', reason, text }
  }
}
