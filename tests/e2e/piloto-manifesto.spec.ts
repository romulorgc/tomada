/**
 * `readIntent` (M4d): o manifesto da gravação que existe e não lê não pode fazer o piloto sumir sem aviso. Ao abrir o app, o projeto
 * ganha o aviso (com o motivo) e a etapa "Transcrever" com erro e o botão "Tentar de novo"; a Biblioteca mostra o aviso no cartão
 * e a Revisão, no alto, com a etapa.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { readSaved } from './editor-helpers'
import { EXAMPLE_FOLDER, launchTomada, shot, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (!s) return
  const problems = s.problems
  await s.close()
  s = undefined
  expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
})

test('manifesto que não lê: a Biblioteca e a Revisão mostram que o piloto não pôde retomar, e por quê', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const base = s.base
  await s.close({ keep: true })
  // a gravação deste projeto deixou um manifesto quebrado (queda no meio da escrita, disco, outra versão do app)
  mkdirSync(join(base, 'projetos', EXAMPLE_FOLDER, 'raw'), { recursive: true })
  writeFileSync(join(base, 'projetos', EXAMPLE_FOLDER, 'raw', 'recording.json'), '{ isto não é um manifesto')
  s = await launchTomada({ base })
  // a inicialização reconcilia e grava o aviso no projeto
  await expect.poll(() => readSaved(s!).autopilot?.notice ?? '', { timeout: 20_000 }).toMatch(/não pôde retomar/)
  const saved = readSaved(s).autopilot!
  expect(saved.steps.find((step) => step.id === 'transcribe')).toMatchObject({ status: 'error' })

  // Biblioteca: o aviso está no cartão do projeto
  await s.page.reload()
  const notice = s.page.getByTestId('card-autopilot-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('O piloto automático não pôde retomar')
  await expect(notice).toContainText('manifesto da gravação')
  await shot(s.page, 'piloto-manifesto-biblioteca')

  // Revisão: o aviso no alto e a etapa com o botão de tentar de novo
  await s.page.getByTestId('card-review').click()
  await expect(s.page.getByTestId('pilot-notice')).toContainText('não pôde retomar')
  const step = s.page.getByTestId('pipeline-transcribe')
  await expect(step).toHaveAttribute('data-status', 'error')
  await expect(step.getByRole('button', { name: 'Tentar de novo' })).toBeVisible()
  await shot(s.page, 'piloto-manifesto-revisao')
})
