/**
 * Tela ativa (F1, item 5): os trechos da gravação em que algo acontece na tela, para a limpeza NÃO tirar um silêncio de cima deles
 * (o clique, a digitação, a página que muda). Só o "miolo parado" do silêncio pode sair. Código puro: sem DOM, sem Node.
 *
 * Fontes (todas no relógio da gravação, ms de ORIGEM):
 *  - clique (`events/clicks.jsonl`): de 400 ms antes até 800 ms depois (o olho segue o clique e a resposta da página);
 *  - tecla (`keys.jsonl`): de 300 ms antes até 600 ms depois; teclas seguidas se juntam;
 *  - mudança de conteúdo (`content-map.jsonl`): cada amostra guardada é uma MUDANÇA medida a cada segundo, então a mudança aconteceu
 *    no segundo que a antecede: de `t − 1000` até `t` (a primeira amostra, `t = 0`, é só a referência e não conta);
 *  - cursor (`cursor.jsonl`): trecho em que o ponteiro anda de verdade (mais de 1,5% da tela em 250 ms, seguido) - o cursor é a
 *    rolagem e a navegação que o evento de clique não registra.
 *
 * Ideia registrada (a linha do tempo ainda não tem trecho acelerado): em vez de só PRESERVAR o silêncio com tela ativa, acelerá-lo
 * em 3× (teto de 2 s) como faz o time-lapse de espera; ver `docs/etapas/F1-emendas.md`.
 */
import type { Range } from './types'

export const CLICK_BEFORE_MS = 400
export const CLICK_AFTER_MS = 800
export const KEY_BEFORE_MS = 300
export const KEY_AFTER_MS = 600
/** O cursor só conta como atividade se andar tanto (fração da diagonal da tela, 0..√2) dentro da janela abaixo. */
export const CURSOR_MOVE_MIN = 0.015
export const CURSOR_WINDOW_MS = 250
/** Atividades que se tocam (ou ficam a menos disto) viram uma só. */
const JOIN_GAP_MS = 150

export type ScreenEvents = {
  clicks?: readonly { t: number; upT?: number }[]
  keys?: readonly { t: number }[]
  cursor?: readonly { t: number; x: number; y: number; out?: boolean }[]
  /** Instantes (ms) das AMOSTRAS do mapa de conteúdo; a primeira é a referência. */
  contentTimes?: readonly number[]
  /** Passo da medida do mapa de conteúdo (ms); padrão 1000. */
  contentStepMs?: number
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
  const times = events.contentTimes ?? []
  for (let i = 1; i < times.length; i++) {
    const t = times[i]!
    if (Number.isFinite(t)) out.push({ start: t - step, end: t })
  }
  if (events.cursor && events.cursor.length > 1) out.push(...cursorMotion(events.cursor))
  return mergeRanges(
    out.map((r) => ({ start: Math.max(0, r.start), end: Math.min(durationMs > 0 ? durationMs : Infinity, r.end) })),
    JOIN_GAP_MS
  )
}
