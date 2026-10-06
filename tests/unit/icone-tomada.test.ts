import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { buildIco } from '../../scripts/gerar-icone.mjs'

function image(size: number): Buffer {
  const png = new PNG({ width: size, height: size })
  png.data.fill(255)
  return PNG.sync.write(png)
}

describe('ícone multi-tamanho', () => {
  it('preserva as dimensões e os pixels PNG, inclusive o tamanho 256 do ICO', () => {
    const frames = [16, 32, 256].map(size => ({ size, png: image(size) }))
    const ico = buildIco(frames)
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(3)
    for (const [index, size] of [16, 32, 256].entries()) {
      const entry = 6 + index * 16
      expect(ico[entry]).toBe(size === 256 ? 0 : size)
      expect(ico[entry + 1]).toBe(size === 256 ? 0 : size)
      expect(ico.readUInt16LE(entry + 4)).toBe(1)
      expect(ico.readUInt16LE(entry + 6)).toBe(32)
      const bytes = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      const decoded = PNG.sync.read(ico.subarray(offset, offset + bytes))
      expect([decoded.width, decoded.height]).toEqual([size, size])
      expect(decoded.data.every(channel => channel === 255)).toBe(true)
    }
  })

  it('recusa uma imagem de tamanho errado antes de escrever um ICO inválido', () => {
    expect(() => buildIco([{ size: 32, png: image(16) }])).toThrow(/dimens/)
    expect(() => buildIco([{ size: 257, png: image(257) }])).toThrow(/1.*256/)
    expect(() => buildIco([])).toThrow(/vazio/)
  })
})
