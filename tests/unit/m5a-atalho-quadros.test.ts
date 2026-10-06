import { expect, it } from 'vitest'
import { PNG } from 'pngjs'
import { syntheticMonitorReady } from '../../scripts/m5a-atalho-quadros.mjs'

function image(color: [number, number, number], title = false): Buffer {
  const png = new PNG({ width: 500, height: 281 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color[0]; png.data[i + 1] = color[1]; png.data[i + 2] = color[2]; png.data[i + 3] = 255
  }
  if (title) for (let y = 90; y < 105; y++) for (let x = 205; x < 295; x++) {
    const pixel = (y * png.width + x) * 4
    png.data[pixel] = 255; png.data[pixel + 1] = 255; png.data[pixel + 2] = 255
  }
  return PNG.sync.write(png)
}

it('thumbnail cinza ou fundo sem título não contam como alvo sintético pronto', () => {
  expect(syntheticMonitorReady(image([240, 240, 240]))).toBe(false)
  expect(syntheticMonitorReady(image([16, 41, 77]))).toBe(false)
  expect(syntheticMonitorReady(image([16, 41, 77], true))).toBe(true)
})
