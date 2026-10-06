import { afterEach, expect, test, vi } from 'vitest'

const originalHidden = process.env.TOMADA_E2E_HIDDEN
afterEach(() => {
  if (originalHidden === undefined) delete process.env.TOMADA_E2E_HIDDEN
  else process.env.TOMADA_E2E_HIDDEN = originalHidden
  vi.resetModules()
})

test('a configuração e2e deixa o Electron oculto por padrão antes da primeira janela', async () => {
  delete process.env.TOMADA_E2E_HIDDEN
  await import('../../playwright.config')
  expect(process.env.TOMADA_E2E_HIDDEN).toBe('1')
})

test('a captura e a prova reais não ativam o modo oculto', async () => {
  delete process.env.TOMADA_E2E_HIDDEN
  await import('../../playwright.real.config')
  await import('../../playwright.prova.config')
  expect(process.env.TOMADA_E2E_HIDDEN).toBeUndefined()
})
