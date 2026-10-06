import { PNG } from 'pngjs'

/** Rejeita thumbnail cinza/vazio e janelas pretas; o alvo tem fundo azul e título branco. */
export function syntheticMonitorReady(bytes) {
  const image = PNG.sync.read(Buffer.from(bytes))
  let white = 0, dark = 0, blue = 0, area = 0
  for (let y = Math.floor(image.height * .29); y < image.height * .41; y++) for (let x = Math.floor(image.width * .35); x < image.width * .65; x++) {
    const pixel = (y * image.width + x) * 4
    if (image.data[pixel] > 220 && image.data[pixel + 1] > 220 && image.data[pixel + 2] > 220) white++
  }
  for (let y = Math.floor(image.height * .1); y < image.height * .9; y++) for (let x = Math.floor(image.width * .1); x < image.width * .9; x++) {
    const pixel = (y * image.width + x) * 4
    const [r, g, b] = image.data.subarray(pixel, pixel + 3)
    area++
    if (r < 10 && g < 10 && b < 15) dark++
    if (r >= 8 && r <= 28 && g >= 30 && g <= 55 && b >= 65 && b <= 100) blue++
  }
  return white > 500 && dark < 300 && blue / area > .7
}
