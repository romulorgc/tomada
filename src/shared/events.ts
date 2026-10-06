/**
 * Leitura dos arquivos de eventos (`events/*.jsonl`, uma linha JSON por evento).
 * Código puro: sem DOM, sem Node (quem lê o arquivo passa o texto).
 */
import type { ClickEvent, ContentRectSample, CursorSample, KeyEvent } from './types'
import type { EventsData } from './scene'

/**
 * Texto JSON Lines → lista. Linha vazia é ignorada. Uma linha inválida no MEIO é erro (arquivo
 * corrompido, com o número da linha); inválida só na ÚLTIMA é descartada (escrita interrompida).
 */
export function parseJsonLines<T>(text: string, label = 'arquivo'): T[] {
  const lines = text.split(/\r?\n/)
  const out: T[] = []
  let lastNonEmpty = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== '') {
      lastNonEmpty = i
      break
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === '') continue
    try {
      out.push(JSON.parse(line) as T)
    } catch (err) {
      if (i === lastNonEmpty) break
      throw new Error(`${label}: linha ${i + 1} não é um JSON válido (${(err as Error).message}).`)
    }
  }
  return out
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Textos dos arquivos → eventos limpos (só os que têm os números certos). `contentRect` (C1) é opcional: a página do navegador. */
export function eventsFromText(text: { cursor?: string; clicks?: string; keys?: string; contentRect?: string }): EventsData {
  const cursor = parseJsonLines<CursorSample>(text.cursor ?? '', 'cursor.jsonl').filter((s) => num(s.t) && num(s.x) && num(s.y))
  const clicks = parseJsonLines<ClickEvent>(text.clicks ?? '', 'clicks.jsonl').filter((c) => num(c.t) && num(c.x) && num(c.y))
  const keys = parseJsonLines<KeyEvent>(text.keys ?? '', 'keys.jsonl').filter((k) => num(k.t))
  const contentRects = parseJsonLines<ContentRectSample>(text.contentRect ?? '', 'content-rect.jsonl').filter((r) => num(r.t) && num(r.x) && num(r.y) && num(r.w) && num(r.h))
  return { cursor, clicks, keys, contentRects }
}

/** Caminhos relativos dos eventos dentro da pasta do projeto. */
export const CONTENT_RECT_FILE = 'content-rect.jsonl'
export const EVENT_FILES = {
  cursor: 'events/cursor.jsonl',
  clicks: 'events/clicks.jsonl',
  keys: 'events/keys.jsonl',
  /** A página do navegador (C1): só existe se foi medida. */
  contentRect: `events/${CONTENT_RECT_FILE}`
} as const
