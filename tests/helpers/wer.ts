/**
 * Taxa de erro de palavras (WER) entre uma referência e uma hipótese, sem ligar para acento, caixa e pontuação.
 * WER = (substituições + remoções + inserções) / palavras da referência (distância de edição por palavra).
 */
import { foldText } from '../../src/shared/text-edit'

export function tokens(text: string): string[] {
  const t = foldText(text)
  return t.length === 0 ? [] : t.split(' ')
}

export function wordErrors(reference: string, hypothesis: string): { distance: number; refWords: number; wer: number } {
  const a = tokens(reference)
  const b = tokens(hypothesis)
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const saved = prev[j]!
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = saved
    }
  }
  const distance = prev[b.length]!
  return { distance, refWords: a.length, wer: a.length === 0 ? (b.length === 0 ? 0 : 1) : distance / a.length }
}
