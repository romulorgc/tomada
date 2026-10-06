/**
 * As fontes das legendas (M4a): Montserrat ExtraBold e Bold, Anton, Inter SemiBold e Bold, todas OFL, EMPACOTADAS no app
 * (`assets/fonts`, com as licenças ao lado). Elas entram no `document.fonts` com `FontFace` e precisam estar CARREGADAS antes
 * do primeiro quadro desenhado, na prévia e na janela escondida da exportação: o Canvas não espera fonte (desenha com a
 * de reserva e não corrige depois), então o primeiro quadro sairia com a fonte errada.
 *
 * Mesma origem do app (`font-src 'self'`): nada de rede.
 */
import antonRegular from './assets/fonts/Anton-Regular.woff2?url'
import interBold from './assets/fonts/Inter-Bold.woff2?url'
import interSemiBold from './assets/fonts/Inter-SemiBold.woff2?url'
import interVariable from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import montserratBold from './assets/fonts/Montserrat-Bold.woff2?url'
import montserratExtraBold from './assets/fonts/Montserrat-ExtraBold.woff2?url'
import { CAPTION_FONT_FILES } from '@shared/caption-style'

const URLS: Record<string, string> = {
  'Anton-Regular.woff2': antonRegular,
  'Inter-Bold.woff2': interBold,
  'Inter-SemiBold.woff2': interSemiBold,
  'inter-latin-wght-normal.woff2': interVariable,
  'Montserrat-Bold.woff2': montserratBold,
  'Montserrat-ExtraBold.woff2': montserratExtraBold
}

let loading: Promise<void> | null = null
let loaded = false

/** As fontes já estão no `document.fonts`, carregadas? */
export function captionFontsLoaded(): boolean {
  return loaded
}

/**
 * Registra e carrega as fontes das legendas (uma vez). A promessa só resolve com TODAS carregadas; se alguma falhar, rejeita
 * com o motivo (a exportação falha à vista em vez de sair com a fonte errada) e a próxima chamada tenta de novo.
 */
export function ensureCaptionFonts(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (loading) return loading
  loading = (async () => {
    const faces: FontFace[] = []
    for (const spec of CAPTION_FONT_FILES) {
      const url = URLS[spec.file]
      if (!url) throw new Error(`Fonte empacotada não encontrada: ${spec.file}`)
      faces.push(new FontFace(spec.family, `url("${url}") format("woff2")`, { weight: String(spec.weight), style: 'normal', display: 'block' }))
    }
    try {
      await Promise.all(faces.map((f) => f.load()))
    } catch (err) {
      throw new Error(`Não consegui carregar as fontes das legendas: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const f of faces) document.fonts.add(f)
    // confere: cada fonte pedida precisa responder "carregada" ao navegador
    for (const spec of CAPTION_FONT_FILES) {
      if (!document.fonts.check(`${spec.weight} 40px "${spec.family}"`)) throw new Error(`A fonte "${spec.family}" (peso ${spec.weight}) não ficou disponível.`)
    }
    loaded = true
  })().catch((err: unknown) => {
    loading = null
    throw err
  })
  return loading
}
