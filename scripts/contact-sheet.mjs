#!/usr/bin/env node
/**
 * Folha de contato: quadros espaçados de um vídeo montados numa imagem só, para conferir a
 * gravação a olho.
 *
 *   node scripts/contact-sheet.mjs <video> <saida.png> [colunas=4] [linhas=3] [largura-do-quadro=480]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function contactSheet(video, out, cols = 4, rows = 3, width = 480) {
  const probe = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration', '-of', 'csv=p=0', video],
    { encoding: 'utf8' }
  )
  const duration = Number.parseFloat(probe)
  if (!(duration > 0)) throw new Error(`Não consegui medir a duração de ${video}.`)
  const tiles = cols * rows
  const every = duration / tiles
  mkdirSync(dirname(out), { recursive: true })
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(Math.min(0.2, every / 2)),
      '-i',
      video,
      '-vf',
      `fps=1/${every.toFixed(4)},scale=${width}:-2,tile=${cols}x${rows}:padding=4:margin=4:color=0x222222`,
      '-frames:v',
      '1',
      out
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [video, out, cols, rows, width] = process.argv.slice(2)
  if (!video || !out) {
    console.error('uso: node scripts/contact-sheet.mjs <video> <saida.png> [colunas] [linhas] [largura]')
    process.exit(2)
  }
  console.log(contactSheet(video, out, cols ? Number(cols) : 4, rows ? Number(rows) : 3, width ? Number(width) : 480))
}
