import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { parseRange, resolveMediaPath } from '../../src/main/media-protocol'

describe('parseRange', () => {
  const size = 1000

  it('sem cabeçalho: resposta inteira', () => {
    expect(parseRange(null, size)).toBeNull()
    expect(parseRange('', size)).toBeNull()
  })

  it('início e fim (inclusivos)', () => {
    expect(parseRange('bytes=0-99', size)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-999', size)).toEqual({ start: 500, end: 999 })
  })

  it('fim além do arquivo é limitado ao último byte', () => {
    expect(parseRange('bytes=900-5000', size)).toEqual({ start: 900, end: 999 })
  })

  it('aberto no fim: até o último byte (o que o <video> pede)', () => {
    expect(parseRange('bytes=0-', size)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=250-', size)).toEqual({ start: 250, end: 999 })
  })

  it('sufixo: os últimos N bytes (o <video> pede o fim do MP4 para achar o moov)', () => {
    expect(parseRange('bytes=-100', size)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', size)).toEqual({ start: 0, end: 999 })
  })

  it('início além do arquivo, invertido, vazio ou sufixo zero: 416', () => {
    expect(parseRange('bytes=1000-1100', size)).toBe('invalid')
    expect(parseRange('bytes=5000-', size)).toBe('invalid')
    expect(parseRange('bytes=500-100', size)).toBe('invalid')
    expect(parseRange('bytes=-', size)).toBe('invalid')
    expect(parseRange('bytes=-0', size)).toBe('invalid')
  })

  it('mais de um intervalo: 416 (não atendemos)', () => {
    expect(parseRange('bytes=0-1,5-9', size)).toBe('invalid')
  })

  it('arquivo vazio: qualquer Range é 416', () => {
    expect(parseRange('bytes=0-', 0)).toBe('invalid')
  })

  it('unidade desconhecida é ignorada (resposta inteira)', () => {
    expect(parseRange('items=0-5', size)).toBeNull()
  })
})

describe('resolveMediaPath', () => {
  const root = resolve('C:\\Videos\\Tomada')
  const url = (path: string): URL => new URL(`tomada-media://project${path}`)

  it('resolve pasta/arquivo dentro da raiz, decodificando espaço e acento', () => {
    expect(resolveMediaPath(url('/Projeto%20n%C2%BA%201/media/screen.mp4'), root)).toBe(join(root, 'Projeto nº 1', 'media', 'screen.mp4'))
  })

  it('barra `..` em qualquer forma', () => {
    // O próprio URL já remove os pontos (/p/../../x vira /x): sobra 1 segmento, que não é pasta+arquivo.
    expect(resolveMediaPath(url('/p/../../win.ini'), root)).toBeNull()
    // Com pasta+arquivo depois da normalização, o resultado continua DENTRO da raiz.
    expect(resolveMediaPath(url('/p/../outra/win.ini'), root)).toBe(join(root, 'outra', 'win.ini'))
    expect(resolveMediaPath(url('/p/%2e%2e/%2e%2e/secret.txt'), root)).toBeNull()
    expect(resolveMediaPath(url('/p/%2E%2E/x.mp4'), root)).toBeNull()
    expect(resolveMediaPath(url('/%2e%2e/x.mp4'), root)).toBeNull()
  })

  it('barra separadores escondidos em %2f e %5c', () => {
    expect(resolveMediaPath(url('/p/a%2f..%2f..%2fx.mp4'), root)).toBeNull()
    expect(resolveMediaPath(url('/p/a%5c..%5c..%5cx.mp4'), root)).toBeNull()
  })

  it('barra letra de unidade e fluxos alternativos do NTFS', () => {
    expect(resolveMediaPath(url('/p/C%3A/x.mp4'), root)).toBeNull()
    expect(resolveMediaPath(url('/p/screen.mp4%3Astream'), root)).toBeNull()
  })

  it('barra NUL e percent-encoding quebrado', () => {
    expect(resolveMediaPath(url('/p/a%00b.mp4'), root)).toBeNull()
    expect(resolveMediaPath(url('/p/%E0%A4%A.mp4'), root)).toBeNull()
  })

  it('exige pelo menos pasta e arquivo', () => {
    expect(resolveMediaPath(url('/'), root)).toBeNull()
    expect(resolveMediaPath(url('/so-a-pasta'), root)).toBeNull()
  })

  it('esquema e host errados', () => {
    expect(resolveMediaPath(new URL('tomada-media://outro/p/a.mp4'), root)).toBeNull()
    expect(resolveMediaPath(new URL('https://project/p/a.mp4'), root)).toBeNull()
  })
})
