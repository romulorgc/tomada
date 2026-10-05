/**
 * Dicionário do usuário (nomes próprios e termos que a transcrição deve acertar). Código puro.
 */

export const DICTIONARY_MAX_TERMS = 200
export const DICTIONARY_MAX_LENGTH = 80

/** Limpa a lista: só texto, sem caracteres de controle, espaços juntos, sem vazios nem repetidos (sem ligar para a caixa). */
export function normalizeDictionary(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const term = item.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DICTIONARY_MAX_LENGTH).trim()
    const key = term.toLocaleLowerCase('pt-BR')
    if (term.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length >= DICTIONARY_MAX_TERMS) break
  }
  return out
}

/** Texto do campo ("um termo por linha" ou separados por vírgula) → lista limpa. */
export function parseDictionaryText(text: string): string[] {
  return normalizeDictionary(text.split(/[\n,;]+/))
}
