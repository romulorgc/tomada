/**
 * O pedido "ache os recomeços" à IA (código puro): o texto do sistema, a transcrição com o índice de cada palavra
 * (em janelas, para transcrições longas) e o esquema da resposta. Só TEXTO da transcrição vai para a IA: nem o
 * áudio, nem o vídeo, nem o caminho de nada.
 */
import { z } from 'zod'
import type { Word } from './types'

export const RETAKES_SYSTEM = `Você revisa a transcrição de um vídeo em que uma pessoa fala para a câmera e aponta os RECOMEÇOS: trechos que ela disse errado, interrompeu ou repetiu e depois refez.

Exemplo: "o botão de login, não, o botão de cadastro fica aqui". A versão abandonada é "o botão de login, não," e deve ser cortada; a versão final ("o botão de cadastro fica aqui") fica.

Cada palavra da transcrição vem com o número dela entre colchetes, no formato [n]palavra. Responda SOMENTE com JSON, sem texto fora dele:
{"retakes":[{"from":N,"to":M,"reason":"motivo em poucas palavras"}]}

"from" e "to" são números de palavra (inclusive) do trecho que deve ser CORTADO: a versão errada ou abandonada, nunca a versão final. Se não houver recomeço, responda {"retakes":[]}.

Regras: não corte frases corretas; não corte repetições de ênfase de propósito ("muito, muito bom"); não corte hesitações soltas ("hum", "é"), que outra etapa trata; use só números que existem na transcrição; prefira não cortar a cortar errado.`

/** Palavras por pedido e quantas se repetem de uma janela para a seguinte (para um recomeço na emenda não escapar). */
export const RETAKES_WINDOW = 1200
export const RETAKES_OVERLAP = 100

/** Esquema (frouxo de propósito): os índices são validados depois, um a um (`validateRetakes`). */
export const retakesSchema = z.object({
  retakes: z.array(z.object({ from: z.unknown(), to: z.unknown(), reason: z.unknown().optional() }))
})
export type RetakesResponse = z.infer<typeof retakesSchema>

const clean = (text: string): string => text.trim().replace(/\s+/g, ' ')

/** Os pedidos (um por janela de palavras): só palavras de verdade, cada uma com o seu número. */
export function buildRetakePrompts(words: readonly Word[]): string[] {
  const real = words.filter((w) => w.kind !== 'gap-speech' && clean(w.text).length > 0)
  const prompts: string[] = []
  if (real.length === 0) return prompts
  for (let from = 0; from < real.length; from += RETAKES_WINDOW - RETAKES_OVERLAP) {
    const slice = real.slice(from, from + RETAKES_WINDOW)
    const body = slice.map((w) => `[${w.i}]${clean(w.text)}`).join(' ')
    prompts.push(`Transcrição:\n${body}`)
    if (from + RETAKES_WINDOW >= real.length) break
  }
  return prompts
}
