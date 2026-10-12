/**
 * Tela ativa (F1, item 5): os trechos da gravação em que algo acontece na tela, para a limpeza NÃO tirar um silêncio de cima deles
 * (o clique, a digitação, a página que muda). Só o "miolo parado" do silêncio pode sair. Código puro: sem DOM, sem Node.
 *
 * Fontes (todas no relógio da gravação, ms de ORIGEM):
 *  - clique (`events/clicks.jsonl`): de 400 ms antes até 800 ms depois (o olho segue o clique e a resposta da página);
 *  - tecla (`keys.jsonl`): de 300 ms antes até 600 ms depois; teclas seguidas se juntam;
 *  - mudança de conteúdo (`content-map.jsonl`, que é também onde a rolagem aparece): cada amostra guardada é uma MUDANÇA medida a
 *    cada segundo, então a mudança aconteceu no segundo que a antecede: de `t − 1000` até `t` (a primeira amostra, `t = 0`, é só a
 *    referência e não conta). Só conta mudança de verdade: variação média da grade de bordas de pelo menos `CONTENT_CHANGE_MIN`
 *    (5%); abaixo disso é cursor piscando, animação pequena, carregamento (G1 e G2: 26 de 48 e 22 de 36 amostras passam de 5%);
 *  - cursor (`cursor.jsonl`): LIGADO só se pedido (`useCursor`). Nas gravações de 09/10 o ponteiro anda o tempo todo (varreduras de
 *    8% da tela em 250 ms seguram 34 de 53 s de pausa em G1 e 13 de 24 s em G2) e a limpeza ficaria parada; o que o cursor
 *    anuncia (rolagem, página nova) já aparece como mudança de conteúdo.
 *
 * Ideia registrada (a linha do tempo ainda não tem trecho acelerado): em vez de só PRESERVAR o silêncio com tela ativa, acelerá-lo
 * em 3× (teto de 2 s) como faz o time-lapse de espera.
 */
import type { CursorData } from './scene'
import type { Range } from './types'

export const CLICK_BEFORE_MS = 400
export const CLICK_AFTER_MS = 800
export const KEY_BEFORE_MS = 300
export const KEY_AFTER_MS = 600
/** O cursor só conta como atividade se andar tanto (fração da diagonal da tela, 0..√2) dentro da janela abaixo. */
export const CURSOR_MOVE_MIN = 0.08
export const CURSOR_WINDOW_MS = 250
/** Mudança média da grade de conteúdo (0..1) a partir da qual a página "mudou" de verdade. */
export const CONTENT_CHANGE_MIN = 0.05
/** Atividades que se tocam (ou ficam a menos disto) viram uma só. */
const JOIN_GAP_MS = 150

export type ScreenEvents = {
  clicks?: readonly { t: number; upT?: number }[]
  keys?: readonly { t: number }[]
  cursor?: readonly { t: number; x: number; y: number; out?: boolean }[]
  /** Mudanças do mapa de conteúdo: instante (ms) da amostra e quanto a grade variou em relação à anterior (0..1). */
  contentChanges?: readonly { t: number; magnitude: number }[]
  /** Passo da medida do mapa de conteúdo (ms); padrão 1000. */
  contentStepMs?: number
  /** Conta o ponteiro andando como atividade (desligado por padrão, ver o cabeçalho). */
  useCursor?: boolean
}

/**
 * Mudanças do mapa de conteúdo (`ContentSample[]`, ordenado): a variação média da grade de cada amostra em relação à anterior. A
 * primeira amostra é só a referência. Devolve só o necessário para `screenActivity` (sem as grades).
 */
export function contentChangesOf(samples: readonly { t: number; cells: ArrayLike<number> }[]): { t: number; magnitude: number }[] {
  const out: { t: number; magnitude: number }[] = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!.cells
    const b = samples[i]!.cells
    const n = Math.min(a.length, b.length)
    if (n === 0) continue
    let sum = 0
    for (let k = 0; k < n; k++) sum += Math.abs(a[k]! - b[k]!)
    out.push({ t: samples[i]!.t, magnitude: sum / n / 255 })
  }
  return out
}

/** Une os intervalos que se tocam; devolve ordenado e sem sobreposição. */
export function mergeRanges(ranges: readonly Range[], joinGapMs = 0): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).map((r) => ({ ...r })).sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + joinGapMs) last.end = Math.max(last.end, r.end)
    else out.push(r)
  }
  return out
}

/** Janelas em que o cursor andou. */
export function cursorMotion(cursor: NonNullable<ScreenEvents['cursor']>): Range[] {
  const out: Range[] = []
  let j = 0
  for (let i = 0; i < cursor.length; i++) {
    const a = cursor[i]!
    if (a.out) continue
    // primeiro j com t > a.t + janela: a amostra de comparação é a última dentro da janela
    while (j < cursor.length && cursor[j]!.t <= a.t + CURSOR_WINDOW_MS) j++
    const b = cursor[j - 1]
    if (!b || b.t <= a.t || b.out) continue
    if (Math.hypot(b.x - a.x, b.y - a.y) >= CURSOR_MOVE_MIN) out.push({ start: a.t, end: b.t })
  }
  return mergeRanges(out, JOIN_GAP_MS)
}

/** Todos os trechos de tela ativa, ordenados e sem sobreposição. */
export function screenActivity(events: ScreenEvents, durationMs: number): Range[] {
  const out: Range[] = []
  for (const c of events.clicks ?? []) {
    if (!Number.isFinite(c.t)) continue
    out.push({ start: c.t - CLICK_BEFORE_MS, end: Math.max(c.t, c.upT ?? c.t) + CLICK_AFTER_MS })
  }
  for (const k of events.keys ?? []) {
    if (Number.isFinite(k.t)) out.push({ start: k.t - KEY_BEFORE_MS, end: k.t + KEY_AFTER_MS })
  }
  const step = events.contentStepMs ?? 1000
  for (const c of events.contentChanges ?? []) {
    if (Number.isFinite(c.t) && c.magnitude >= CONTENT_CHANGE_MIN) out.push({ start: c.t - step, end: c.t })
  }
  if (events.useCursor && events.cursor && events.cursor.length > 1) out.push(...cursorMotion(events.cursor))
  return mergeRanges(
    out.map((r) => ({ start: Math.max(0, r.start), end: Math.min(durationMs > 0 ? durationMs : Infinity, r.end) })),
    JOIN_GAP_MS
  )
}

/** A tela ativa de uma gravação a partir dos eventos já preparados (`prepareEvents`): é o que a Revisão e o piloto usam. */
export function screenActivityOfData(data: Pick<CursorData, 'clicks' | 'keys' | 'contentMap' | 'durationMs'>, durationMs: number = data.durationMs): Range[] {
  return screenActivity({ clicks: data.clicks, keys: data.keys, contentChanges: contentChangesOf(data.contentMap) }, durationMs)
}
