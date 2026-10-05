/**
 * Política de conteúdo (CSP) das páginas do app. Código puro: o `electron.vite.config.ts` a injeta no `index.html`
 * do build e os testes conferem o texto.
 *
 * Nada de rede: imagem, mídia e `fetch` só do próprio app e do protocolo `tomada-media:` (arquivos do projeto).
 * Sem `http:`, `https:`, `ws:` nem `*` em diretiva nenhuma. (`data:` só em imagem e fonte: as miniaturas das telas
 * a gravar chegam assim.)
 */
export const CSP_DIRECTIVES: Record<string, readonly string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'tomada-media:'],
  'media-src': ["'self'", 'blob:', 'tomada-media:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'tomada-media:'],
  'worker-src': ["'self'", 'blob:'],
  'frame-src': ["'none'"],
  'object-src': ["'none'"],
  'form-action': ["'none'"],
  'base-uri': ["'none'"]
}

export function buildCsp(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ')
}
