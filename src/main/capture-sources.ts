/**
 * Fontes de captura (telas e janelas) com miniatura, e o manipulador do
 * `getDisplayMedia` que entrega a fonte já escolhida na tela Gravar (sem o seletor do
 * Chromium). Depende do Electron; a parte de lógica (casar display e monitor, escolher o
 * retângulo) está em `@shared/recording`.
 */
import { desktopCapturer, screen, type Session } from 'electron'
import type { SourceInfo } from '@shared/ipc'
import { resolveScreenRect, type MonitorRect } from '@shared/recording'
import type { Rect } from '@shared/types'
import type { Logger } from './logger'
import type { ResolvedSource, SourceProvider } from './recording-service'
import { loadWin32 } from './win32'

const THUMB = { width: 320, height: 180 }
const NO_THUMB = { width: 0, height: 0 }

/** `window:66572:0` → 66572 (o HWND). `screen:0:0` → 0. */
export function hwndOfSourceId(id: string): number {
  return Number(id.split(':')[1])
}

export type SourceProviderDeps = {
  logger: Logger
  /** HWNDs das janelas do próprio Tomada (não podem ser gravadas nem aparecer na lista). */
  ownHwnds(): Set<number>
  env: NodeJS.ProcessEnv
}

export type ElectronSourceProvider = SourceProvider & {
  /** Instala o `setDisplayMediaRequestHandler` na sessão. */
  installDisplayMediaHandler(ses: Session): void
}

export function createSourceProvider(deps: SourceProviderDeps): ElectronSourceProvider {
  const { logger } = deps
  let armed: { id: string; audio: boolean } | null = null

  const monitorsSafe = (): MonitorRect[] => {
    try {
      return loadWin32().monitors()
    } catch (err) {
      logger.warn('Não consegui listar os monitores pelo Win32.', err)
      return []
    }
  }

  const displayOf = (displayId: string): Electron.Display | undefined =>
    screen.getAllDisplays().find((d) => String(d.id) === displayId)

  const jpeg = (img: Electron.NativeImage): string =>
    img.isEmpty() ? '' : `data:image/jpeg;base64,${img.toJPEG(72).toString('base64')}`

  return {
    async list() {
      const own = deps.ownHwnds()
      const all = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: THUMB, fetchWindowIcons: false })
      const primaryId = String(screen.getPrimaryDisplay().id)
      const screens: SourceInfo[] = []
      const windows: SourceInfo[] = []
      for (const s of all) {
        if (s.id.startsWith('screen:')) {
          const display = displayOf(s.display_id)
          const sizePx = display ? screen.dipToScreenRect(null, display.bounds) : null
          screens.push({
            id: s.id,
            kind: 'screen',
            name: s.name,
            thumbnail: jpeg(s.thumbnail),
            primary: s.display_id === primaryId,
            ...(sizePx ? { sizePx: { w: sizePx.width, h: sizePx.height } } : {})
          })
        } else if (s.id.startsWith('window:')) {
          if (own.has(hwndOfSourceId(s.id))) continue
          if (s.name.trim() === '') continue
          windows.push({ id: s.id, kind: 'window', name: s.name, thumbnail: jpeg(s.thumbnail) })
        }
      }
      screens.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, 'pt-BR', { numeric: true }))
      windows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      return [...screens, ...windows]
    },

    async resolve(id): Promise<ResolvedSource> {
      const kind = id.startsWith('window:') ? 'window' : 'screen'
      if (kind === 'window' && deps.ownHwnds().has(hwndOfSourceId(id))) {
        throw new Error('Não dá para gravar a própria janela do Tomada. Escolha outra tela ou janela.')
      }
      const found = (await desktopCapturer.getSources({ types: [kind], thumbnailSize: NO_THUMB })).find((s) => s.id === id)
      if (!found) throw new Error('A tela ou janela escolhida não existe mais. Escolha de novo.')

      if (kind === 'screen') {
        const display = displayOf(found.display_id) ?? screen.getPrimaryDisplay()
        const dipRect = display.bounds
        const rectPx: Rect = (() => {
          const r = screen.dipToScreenRect(null, dipRect)
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        })()
        const resolution = resolveScreenRect({ rectPx }, monitorsSafe())
        if (resolution.note) logger.warn(resolution.note)
        logger.info(`Tela "${found.name}": ${resolution.rect.w}×${resolution.rect.h} em (${resolution.rect.x}, ${resolution.rect.y}), escala ${display.scaleFactor} (retângulo do ${resolution.source})`)
        return {
          id,
          kind,
          name: found.name,
          hwnd: null,
          rectPx: resolution.rect,
          nativeSize: { w: resolution.rect.w, h: resolution.rect.h },
          scale: display.scaleFactor,
          displayBoundsDip: { x: dipRect.x, y: dipRect.y, w: dipRect.width, h: dipRect.height }
        }
      }

      const hwnd = hwndOfSourceId(id)
      const w32 = loadWin32()
      if (!w32.isWindow(hwnd)) throw new Error('A janela escolhida não existe mais. Escolha de novo.')
      if (w32.isIconic(hwnd)) throw new Error('A janela escolhida está minimizada. Restaure-a e escolha de novo.')
      const frame = w32.frameRect(hwnd)
      const client = w32.clientRect(hwnd)
      if (!frame || !client) throw new Error('Não consegui medir a janela escolhida.')
      const dipFrame = screen.screenToDipRect(null, { x: frame.x, y: frame.y, width: frame.w, height: frame.h })
      const display = screen.getDisplayMatching(dipFrame)
      // O quadro do Chromium para janela de outro programa é a moldura inteira (ver `chooseCaptureRect`).
      logger.info(`Janela "${found.name}": moldura ${frame.w}×${frame.h}, cliente ${client.w}×${client.h}, escala ${display.scaleFactor}`)
      return {
        id,
        kind,
        name: found.name,
        hwnd,
        rectPx: frame,
        nativeSize: { w: frame.w, h: frame.h },
        scale: display.scaleFactor,
        displayBoundsDip: { x: display.bounds.x, y: display.bounds.y, w: display.bounds.width, h: display.bounds.height }
      }
    },

    arm(id, audio) {
      armed = { id, audio }
    },

    disarm() {
      armed = null
    },

    installDisplayMediaHandler(ses) {
      ses.setDisplayMediaRequestHandler(
        async (_request, callback) => {
          try {
            let target = armed
            if (!target && deps.env.TOMADA_TEST_AUTOSOURCE === 'screen') {
              const primary = String(screen.getPrimaryDisplay().id)
              const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: NO_THUMB })
              const pick = screens.find((s) => s.display_id === primary) ?? screens[0]
              if (pick) target = { id: pick.id, audio: false }
            }
            if (!target) {
              logger.warn('getDisplayMedia chamado sem fonte escolhida; recusado.')
              callback({})
              return
            }
            const kind = target.id.startsWith('window:') ? 'window' : 'screen'
            const list = await desktopCapturer.getSources({ types: [kind], thumbnailSize: NO_THUMB })
            const video = list.find((s) => s.id === target!.id)
            if (!video) {
              logger.warn(`A fonte ${target.id} sumiu antes da captura começar.`)
              callback({})
              return
            }
            callback({ video, ...(target.audio ? { audio: 'loopback' as const } : {}) })
          } catch (err) {
            logger.error('O manipulador do getDisplayMedia falhou.', err)
            callback({})
          }
        },
        { useSystemPicker: false }
      )
    }
  }
}
