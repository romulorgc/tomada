/**
 * Ler o JSON que a IA devolve (código puro). Modelos de linguagem erram o formato de formas previsíveis: cercam o
 * JSON de ```json … ```, escrevem uma frase antes ou depois, deixam vírgula sobrando. Aqui só se extrai o objeto;
 * a validação de CONTEÚDO é do esquema (zod) de cada tarefa, e o que não passa vira nova tentativa e depois erro visível.
 */
import type { z } from 'zod'

/** Falha de uma pergunta à IA, com a frase que a pessoa vê. */
export class LlmError extends Error {
  override readonly name = 'LlmError'
  constructor(
    message: string,
    /** Vale tentar de novo (rede, tempo) ou não (sem chave, sem programa)? */
    readonly retryable = false
  ) {
    super(message)
  }
}

/** O pedaço do texto que parece o JSON (objeto ou lista), sem cerca de código nem conversa em volta. */
export function extractJsonText(text: string): string {
  const trimmed = text.trim()
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(trimmed)
  const body = (fenced ? fenced[1]! : trimmed).trim()
  const open = body.search(/[{[]/)
  if (open < 0) return body
  const closer = body[open] === '{' ? '}' : ']'
  const close = body.lastIndexOf(closer)
  return close > open ? body.slice(open, close + 1) : body.slice(open)
}

export type JsonParse<T> = { ok: true; value: T } | { ok: false; error: string }

/** Texto da IA → objeto validado pelo esquema. Nunca lança: o motivo vai em `error` (para o pedido de correção). */
export function parseLlmJson<T>(text: string, schema: z.ZodType<T>): JsonParse<T> {
  const body = extractJsonText(text)
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return { ok: false, error: `não é um JSON válido (${(err as Error).message})` }
  }
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, value: parsed.data }
  const why = parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
    .join('; ')
  return { ok: false, error: `o JSON não tem o formato pedido (${why})` }
}

/** O pedido de correção da segunda tentativa. */
export function correctionPrompt(original: string, previous: string, error: string): string {
  const shown = previous.length > 1500 ? `${previous.slice(0, 1500)}…` : previous
  return `${original}\n\n---\nSua resposta anterior não pôde ser usada: ${error}.\nResposta anterior:\n${shown}\n\nResponda de novo SOMENTE com o JSON corrigido, sem nenhum texto fora dele.`
}
