/** Acabamento D: o YouTube do piloto sai em 1440p por padrão; Ajustes → Piloto automático mantém o 1080p como opção. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchTomada, shot, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => { if (s) { const problems = s.problems; await s.close(); s = undefined; expect(problems).toEqual([]) } })

test('Ajustes: resolução do YouTube no piloto vem em 1440p e a escolha de 1080p fica salva', async () => {
  s = await launchTomada({ autopilot: true })
  const { page } = s
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('settings-view')).toBeVisible()
  const select = page.getByTestId('autopilot-youtube-resolution')
  await select.scrollIntoViewIfNeeded()
  await expect(select).toHaveValue('1440p')
  await expect(select.locator('option')).toHaveText(['1440p (padrão: o YouTube dá codec melhor)', '1080p (exporta mais rápido)'])
  await shot(page, 'acabamento-ajustes-resolucao-youtube')
  await select.selectOption('1080p')
  await expect.poll(() => (JSON.parse(readFileSync(join(s!.userData, 'settings.json'), 'utf8')) as { autopilot?: { youtubeResolution?: string } }).autopilot?.youtubeResolution).toBe('1080p')
  await expect(select).toHaveValue('1080p')
})
