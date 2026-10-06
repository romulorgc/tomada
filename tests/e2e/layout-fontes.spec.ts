/** A trilha Layout descreve o que a prévia consegue mostrar com as fontes do projeto. */
import { expect, test } from '@playwright/test'
import { openEditor } from './editor-helpers'
import { editProject } from './export-helpers'
import { launchTomada, type Session } from './helpers'

let session: Session | undefined
test.afterEach(async () => {
  if (!session) return
  const problems = session.problems
  await session.close()
  session = undefined
  expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
})

const sources = [
  { mode: 'só tela', screen: true, camera: false, label: 'Só a tela' },
  { mode: 'só câmera', screen: false, camera: true, label: 'Só a câmera' },
  { mode: 'tela e câmera', screen: true, camera: true, label: 'Tela e câmera' }
] as const

for (const source of sources) {
  for (const segment of [false, true]) {
    test(`trilha Layout: ${segment ? 'trecho' : 'padrão do vídeo'} com ${source.mode}`, async () => {
      session = await launchTomada()
      editProject(session, p => {
        if (!source.screen) delete p.sources.screen
        if (!source.camera) delete p.sources.camera
        // Projetos existentes podem conservar a bolha mesmo quando uma fonte está ausente.
        p.style.defaultLayout = 'bubble'
        p.layouts = segment ? [{ id: 'fontes', start: 0, end: 5000, layout: 'bubble' }] : []
        p.zoomPreset = 'off'
      })
      await openEditor(session)

      const { page } = session
      if (segment) {
        const item = page.getByTestId('seg-layout-fontes')
        await expect(item).toHaveText(source.label)
        await expect(item).toHaveAttribute('title', `Layout: ${source.label}`)
        await expect(item).toHaveAttribute('aria-label', `Layout: ${source.label}`)
      } else {
        await expect(page.getByTestId('track-layout')).toHaveText(`Layout do vídeo: ${source.label}. Arraste aqui para trocar só um trecho`)
      }
    })
  }
}
