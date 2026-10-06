// Converte o vetor do Tomada em PNG e ICO sem serviço de imagem nem dependência nova.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function buildIco(frames) {
  if (!frames.length) throw new Error('O ícone não pode ficar vazio.')
  const header = Buffer.alloc(6 + frames.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  frames.forEach(({ size, png }, index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error('Cada tamanho precisa estar entre 1 e 256 pixels.')
    if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
        png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
      throw new Error('As dimensões do PNG não correspondem à entrada do ICO.')
    }
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...frames.map(frame => frame.png)])
}

async function browserOptions() {
  for (const candidate of [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ]) {
    try { await access(candidate); return { executablePath: candidate } } catch { /* tenta o próximo */ }
  }
  return {}
}

export async function generateIcon({ source, outputDir } = {}) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const input = source ?? path.join(root, 'resources', 'tomada.svg')
  const dest = outputDir ?? path.join(root, 'resources')
  const svg = await readFile(input, 'utf8')
  // O SVG é uma fonte local nossa. Não permite referências externas na conversão.
  if (/\b(?:href|src)\s*=|<!DOCTYPE|<script|<foreignObject|url\(/i.test(svg)) {
    throw new Error('O vetor do ícone precisa ser autocontido, sem rede nem scripts.')
  }
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ ...await browserOptions(), headless: true, args: ['--disable-gpu'] })
  const frames = []
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 })
    await page.route('**/*', route => route.abort())
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`)
    for (const size of ICON_SIZES) {
      await page.setViewportSize({ width: size, height: size })
      frames.push({ size, png: await page.screenshot({ type: 'png', omitBackground: true, animations: 'disabled' }) })
    }
  } finally {
    await browser.close()
  }
  await mkdir(dest, { recursive: true })
  const ico = path.join(dest, 'tomada.ico')
  const png = path.join(dest, 'tomada.png')
  await writeFile(ico, buildIco(frames))
  await writeFile(png, frames.at(-1).png)
  return { source: input, ico, png, sizes: [...ICON_SIZES] }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateIcon().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`Não foi possível gerar o ícone: ${error.message}`)
    process.exitCode = 1
  })
}
