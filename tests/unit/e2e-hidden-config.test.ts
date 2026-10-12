import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  // a configuração da prova ponta a ponta é opcional (não existe em todas as cópias do repositório)
  const prova = resolve('playwright.prova.config.ts')
  if (existsSync(prova)) await import(/* @vite-ignore */ pathToFileURL(prova).href)
  expect(process.env.TOMADA_E2E_HIDDEN).toBeUndefined()
})
