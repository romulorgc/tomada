/** A IA recebe somente palavras numeradas e o dicionário. A aplicação conserva o texto original e confere cada troca. */
import { dictionaryResponseSchema } from '@shared/dictionary-corrections'
import { normalizeDictionary } from '@shared/dictionary'
import type { Word } from '@shared/types'
import type { LlmProvider } from './provider'

const SYSTEM = `Confira nomes de produtos na transcrição de uma demonstração de programa. Use a grafia exata do dicionário SOMENTE quando o contexto identificar uma referência ao produto. Uma palavra comum com som parecido não é um nome: "sintoma de febre" permanece sintoma; a demonstração do sistema Sintomax pode mencionar Sintomax.
Não faça substituição global e não invente nomes. Cada troca aponta o índice i da primeira palavra e, para um nome dividido pelo motor ("Agen daí" → "Agendaí"), last da última palavra. before contém exatamente as palavras originais desse intervalo, na mesma ordem, unidas por espaço e com pontuação. Só junte palavras adjacentes do mesmo nome; nunca remova outras palavras da frase. term deve ser exatamente uma entrada do dicionário, sem acrescentar pontuação. context é product, common ou uncertain; confidence vai de 0 a 1. Só product com confiança de pelo menos 0,90 é aplicado. Preserve dúvidas e usos comuns.
Responda somente JSON: {"corrections":[{"i":0,"last":0,"before":"...","term":"...","confidence":0.99,"context":"product"}]}. last é opcional para uma só palavra. Se nada deve mudar, devolva corrections vazio.`

export async function detectDictionaryCorrections(args: { provider: LlmProvider; words: readonly Word[]; dictionary: readonly string[] }): Promise<unknown[]> {
  const dictionary = normalizeDictionary([...args.dictionary])
  if (dictionary.length === 0 || args.words.length === 0) return []
  const corrections: unknown[] = []
  for (let from = 0; from < args.words.length; from += 1500) {
    const words = args.words.slice(Math.max(0, from - 30), from + 1530)
    const r = await args.provider.complete({ task: 'dictionary', system: SYSTEM, prompt: `Grafias do dicionário: ${JSON.stringify(dictionary)}\n\nPalavras da transcrição (avalie o contexto de produto):\n${words.map((w) => `[${w.i}] ${w.text}`).join('\n')}`, schema: dictionaryResponseSchema })
    corrections.push(...r.corrections)
  }
  return corrections
}
