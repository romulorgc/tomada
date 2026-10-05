/**
 * Léxico das muletas do português falado (código puro). Duas classes:
 *
 *  - **hesitação pura** ("hã", "hum", "ahn", "éé", "eh"): não diz nada, é cortada por padrão;
 *  - **muleta que pode ter sentido** ("né", "tipo", "então", "é"): só vira SUGESTÃO, e só quando o contexto
 *    mostra que é vício (isolada por pausa, repetida ou colada numa hesitação). Quem decide é `clean.ts`.
 *
 * O conjunto é FECHADO de propósito: reconhecer "qualquer coisa que pareça um som" cortaria palavras de verdade.
 */

/** Minúsculas, sem pontuação nem hífen: só letras e números ("Hum..." → "hum", "é-é" → "éé"). */
export function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** Hesitações puras, já normalizadas. "ah" sozinho NÃO entra (é interjeição de verdade: "Ah, entendi"). */
const HESITATION = /^(hã+n?|hu+m+|h?m{2,}|hm+|ahn+|ahm+|ãh+n*|ãã+h*|aah+n*|eh+n?|ehm+|éé+h*|é+h+|uh+n?|uhm+)$/

/** A palavra é uma hesitação pura? */
export function isHesitation(text: string): boolean {
  const n = normalizeToken(text)
  return n.length > 0 && HESITATION.test(n)
}

/** Muletas que podem ter sentido (normalizadas). */
const SOFT_CRUTCHES = new Set(['né', 'tipo', 'então', 'é'])

/** A palavra é uma muleta que pode ter sentido ("né", "tipo", "então", "é")? */
export function isSoftCrutch(text: string): boolean {
  return SOFT_CRUTCHES.has(normalizeToken(text))
}
