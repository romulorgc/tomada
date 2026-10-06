/**
 * Navegadores e a área da PÁGINA dentro da janela (C1). Código puro: sem DOM, sem Node. Quem fala com o Win32 é
 * `src/main/win32.ts`; aqui moram o que decide (qual programa é navegador, qual janela-filha é a página).
 *
 * Medido nesta máquina (Chrome 154 e Edge 154, Windows 11, 125%): a janela de nível superior é `Chrome_WidgetWin_1` e a
 * página é uma janela-filha `Chrome_RenderWidgetHostHWND` (texto "Chrome Legacy Window"). Há várias; só a da aba ativa é visível.
 * Com o DevTools acoplado aparece uma SEGUNDA visível, do tamanho da área inteira de conteúdo, que CONTÉM a da página (que
 * encolhe de verdade: à direita 664×834 de 1358×834, embaixo 1358×459, à esquerda 665×834 em x deslocado). A janela
 * `Intermediate D3D Window` cobre a moldura toda (não serve).
 */
import type { Rect } from './types'

export type BrowserEngine = 'chromium' | 'gecko'
export type BrowserKind = { exe: string; engine: BrowserEngine }

/** Navegadores Chromium conhecidos (nome do executável, minúsculo). */
export const CHROMIUM_EXES: readonly string[] = ['chrome.exe', 'msedge.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'chromium.exe', 'thorium.exe', 'arc.exe', 'comet.exe']
/** Firefox e derivados: reconhecidos, mas a página NÃO é medida (não há janela-filha de conteúdo medida com confiança). */
export const GECKO_EXES: readonly string[] = ['firefox.exe', 'librewolf.exe', 'waterfox.exe', 'zen.exe']

/** Nome do executável (sem a pasta) em minúsculo. */
export function exeName(imagePath: string): string {
  const parts = imagePath.split(/[\\/]/)
  return (parts[parts.length - 1] ?? '').trim().toLowerCase()
}

/** Caminho do executável → qual navegador é (ou `null`: não é navegador, ou não se sabe). */
export function browserOfExe(imagePath: string | null | undefined): BrowserKind | null {
  if (!imagePath) return null
  const exe = exeName(imagePath)
  if (CHROMIUM_EXES.includes(exe)) return { exe, engine: 'chromium' }
  if (GECKO_EXES.includes(exe)) return { exe, engine: 'gecko' }
  return null
}

export const CHROMIUM_PAGE_CLASS = 'Chrome_RenderWidgetHostHWND'

export type ChildWindow = { className: string; visible: boolean; rect: Rect }

const area = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h)
const TOL = 2

/** `inner` cabe dentro de `outer` (com folga de 2 px)? */
function inside(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x - TOL && inner.y >= outer.y - TOL && inner.x + inner.w <= outer.x + outer.w + TOL && inner.y + inner.h <= outer.y + outer.h + TOL
}

/**
 * Qual janela-filha é a PÁGINA. Entre as `Chrome_RenderWidgetHostHWND` visíveis: descarta as que CONTÊM outra menor (a área de
 * conteúdo inteira que aparece com o DevTools acoplado) e fica com a maior das que sobram. Devolve `null` se nenhuma serve
 * ou se ela sai da moldura (rastro de uma janela em movimento): quem chama mantém o último valor bom.
 */
export function pickChromiumPage(children: readonly ChildWindow[], frame: Rect): Rect | null {
  const candidates = children.filter((c) => c.className === CHROMIUM_PAGE_CLASS && c.visible && c.rect.w >= 16 && c.rect.h >= 16).map((c) => c.rect)
  if (candidates.length === 0) return null
  const leaves = candidates.filter((a) => !candidates.some((b) => b !== a && area(b) < area(a) && inside(b, a)))
  const pool = leaves.length > 0 ? leaves : candidates
  let best = pool[0]!
  for (const r of pool) if (area(r) > area(best)) best = r
  // tem de estar (quase toda) dentro da moldura da janela: a janela pode estar no meio de um arraste
  if (frame.w > 0 && frame.h > 0 && !inside(best, { x: frame.x - 8, y: frame.y - 8, w: frame.w + 16, h: frame.h + 16 })) return null
  return { ...best }
}
