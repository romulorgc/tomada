import { describe, expect, it } from 'vitest'
import { createLaunchConfig, installShortcuts, quoteWindowsArg } from '../../scripts/criar-atalhos.mjs'

describe('alvo do lançador', () => {
  it('resolve o Electron e a entrada do app no checkout solicitado com acento', () => {
    const config = createLaunchConfig('C:\\Users\\José\\Downloads\\Tomada')
    expect(config.executable).toBe('C:\\Users\\José\\Downloads\\Tomada\\node_modules\\electron\\dist\\electron.exe')
    expect(config.args).toEqual(['C:\\Users\\José\\Downloads\\Tomada'])
    expect(config.workingDir).toBe('C:\\Users\\José\\Downloads\\Tomada')
    expect(config.requiredFiles).toContain('C:\\Users\\José\\Downloads\\Tomada\\out\\main\\index.js')
  })

  it('mantém espaços, aspas e a barra final como parte do argumento Windows', () => {
    expect(quoteWindowsArg('C:\\Users\\José\\Minha pasta\\')).toBe('"C:\\Users\\José\\Minha pasta\\\\"')
    expect(quoteWindowsArg('fala "curta"')).toBe('"fala \\"curta\\""')
    expect(quoteWindowsArg('')).toBe('""')
  })

  it('recusa variável de ambiente embutida e quebra de linha na entrada do lançador', () => {
    expect(() => createLaunchConfig('C:\\%TEMP%\\Tomada')).toThrow(/variável/)
    expect(() => createLaunchConfig('C:\\Tomada\n')).toThrow(/inválido/)
    expect(() => createLaunchConfig('relativo\\Tomada')).toThrow(/absoluto/)
  })

  it('recusa instalar o lançador dentro do checkout que só pode ser lido', async () => {
    await expect(installShortcuts({
      appDir: 'C:\\tmp\\app-somente-leitura',
      launchDir: 'C:\\tmp\\app-somente-leitura\\launch'
    })).rejects.toThrow(/fora.*app/)
  })
})
