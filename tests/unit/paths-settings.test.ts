import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { ENV_PROJECTS_DIR, defaultProjectsDir, resolveProjectsDir } from '../../src/main/paths'
import { applySettingsPatch } from '../../src/main/settings'
import { assertProjectId, InvalidProjectIdError } from '../../src/main/projects'
import { createMemoryLogger } from '../../src/main/logger'

describe('resolveProjectsDir', () => {
  const home = 'C:\\Users\\Teste'

  it('padrão: Videos\\Tomada na pasta do usuário', () => {
    expect(defaultProjectsDir(home)).toBe(join(home, 'Videos', 'Tomada'))
    expect(resolveProjectsDir({ env: {}, settings: {}, home })).toEqual({
      projectsDir: join(home, 'Videos', 'Tomada'),
      projectsDirSource: 'default'
    })
  })

  it('o ajuste do usuário vence o padrão', () => {
    expect(resolveProjectsDir({ env: {}, settings: { projectsDir: 'D:\\Meus Videos' }, home })).toEqual({
      projectsDir: 'D:\\Meus Videos',
      projectsDirSource: 'settings'
    })
  })

  it('TOMADA_PROJECTS_DIR (testes) vence tudo', () => {
    expect(resolveProjectsDir({ env: { [ENV_PROJECTS_DIR]: 'E:\\tmp\\p' }, settings: { projectsDir: 'D:\\x' }, home })).toEqual({
      projectsDir: 'E:\\tmp\\p',
      projectsDirSource: 'env'
    })
  })

  it('variável vazia ou só espaços é ignorada', () => {
    expect(resolveProjectsDir({ env: { [ENV_PROJECTS_DIR]: '   ' }, settings: {}, home }).projectsDirSource).toBe('default')
  })
})

describe('applySettingsPatch', () => {
  it('muda, mantém o que não veio e apaga com string vazia', () => {
    const a = applySettingsPatch({ projectsDir: 'A', ffmpegPath: 'F' }, { projectsDir: 'B' })
    expect(a).toEqual({ projectsDir: 'B', ffmpegPath: 'F' })
    const b = applySettingsPatch(a, { ffmpegPath: '' })
    expect(b).toEqual({ projectsDir: 'B' })
    const c = applySettingsPatch(b, {})
    expect(c).toEqual({ projectsDir: 'B' })
  })
  it('apara espaços e não altera o original', () => {
    const cur = { projectsDir: 'A' }
    const next = applySettingsPatch(cur, { projectsDir: '  C:\\x  ' })
    expect(next.projectsDir).toBe('C:\\x')
    expect(cur.projectsDir).toBe('A')
  })
})

describe('assertProjectId', () => {
  it('aceita nome de pasta comum, com espaço e acento', () => {
    expect(() => assertProjectId('2026-10-04 1530 Aula de Psicanálise')).not.toThrow()
    expect(() => assertProjectId('exemplo')).not.toThrow()
  })
  it.each(['', '.', '..', '../x', 'a/b', 'a\\b', 'C:\\x', 'c:', 'a*b', 'a?b', 'a|b', 'a\0b', ' espaço', 'espaço '])(
    'recusa %j',
    (id) => {
      expect(() => assertProjectId(id)).toThrow(InvalidProjectIdError)
    }
  )
  it('recusa o que não é texto', () => {
    expect(() => assertProjectId(undefined)).toThrow(InvalidProjectIdError)
    expect(() => assertProjectId(42)).toThrow(InvalidProjectIdError)
    expect(() => assertProjectId({})).toThrow(InvalidProjectIdError)
  })
})

describe('logger de memória', () => {
  it('guarda nível, mensagem e detalhe (erros com pilha)', () => {
    const log = createMemoryLogger()
    log.warn('cuidado', { a: 1 })
    log.error('quebrou', new Error('motivo'))
    expect(log.entries[0]).toEqual({ level: 'warn', message: 'cuidado', detail: '{"a":1}' })
    expect(log.entries[1]?.detail).toContain('motivo')
  })
})
