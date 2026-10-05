/**
 * PRANCHA do enquadramento do rosto na gravação REAL do usuário (`gravacoes/`, só nesta máquina): roda o detector de verdade, monta o
 * caminho do rosto com o MESMO código do app (`buildFaceFramer` → `faceAimAt` → `cameraCropRect`) e desenha, para vários instantes, o
 * quadro inteiro com o retângulo do recorte e, embaixo, o recorte que o cartão da câmera mostra (em pé 3:4, quadrado 1:1 e à mão).
 * Saída em `test-results/camera/` (fora do git; nada disto vai para `tests/`). Pela fila pesada (usa o detector e o ffmpeg):
 *   node scripts/fila-pesada.mjs npx vitest run -c vitest.medir.config.ts tests/medir/prancha-rosto.run.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createPythonCamera } from '../../src/main/camera/python-engine'
import { createMemoryLogger } from '../../src/main/logger'
import { ensureToolsDir, toolPaths } from '../../src/main/transcription/tools-dir'
import { buildFaceFramer, cameraCropRect, faceAimAt } from '../../src/shared/face'
import { ROOT } from '../helpers/fs'

const REAL = join(ROOT, 'gravacoes', '2026-07-26-13-57-59', 'camera.mp4')
const OUT = join(ROOT, 'test-results', 'camera')
const TIMES = [1, 4, 8, 12, 16, 20, 24, 27]

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' })
}

it('prancha do enquadramento do rosto na gravação real', async () => {
  expect(existsSync(REAL), 'a gravação real do usuário fica em gravacoes/ (só nesta máquina)').toBe(true)
  mkdirSync(OUT, { recursive: true })
  const engine = createPythonCamera({ tools: toolPaths(ensureToolsDir()), scriptPath: join(ROOT, 'resources', 'camera_tools.py'), logger: createMemoryLogger() })
  const track = await engine.detectFaces({ video: REAL, durationMs: 28_672 })
  const framer = buildFaceFramer(track, 0, 28_672)
  expect(framer, 'a gravação real tem rosto').not.toBeNull()
  writeFileSync(join(OUT, 'rosto-resumo.json'), JSON.stringify({ frame: track.frame, caixas: track.boxes.length, faceW: framer!.faceW, faceH: framer!.faceH }, null, 1))

  const cam = { w: track.frame.w, h: track.frame.h }
  const px = (r: { x: number; y: number; w: number; h: number }) => ({ x: Math.round(r.x * cam.w), y: Math.round(r.y * cam.h), w: Math.round(r.w * cam.w), h: Math.round(r.h * cam.h) })
  const cell = 270
  const tiles: string[] = []
  for (const t of TIMES) {
    const aim = faceAimAt(framer!, t * 1000)
    const portrait = px(cameraCropRect(cam, 3 / 4, aim))
    const square = px(cameraCropRect(cam, 1, aim))
    const manual = px(cameraCropRect(cam, 3 / 4, aim, { auto: false, zoom: 1.6, dx: -0.05, dy: 0 }))
    const name = (k: string): string => join(OUT, `t${t}-${k}.png`)
    const sc = 480 / cam.w
    const box = (r: { x: number; y: number; w: number; h: number }, color: string): string => `drawbox=x=${Math.round(r.x * sc)}:y=${Math.round(r.y * sc)}:w=${Math.round(r.w * sc)}:h=${Math.round(r.h * sc)}:color=${color}:t=3`
    ffmpeg(['-ss', String(t), '-i', REAL, '-frames:v', '1', '-vf', `scale=480:270,${box(portrait, 'red')},${box(square, 'yellow')}`, name('inteiro')])
    for (const [k, r, ar] of [['pe', portrait, 3 / 4], ['quadrado', square, 1], ['mao', manual, 3 / 4]] as const) {
      ffmpeg(['-ss', String(t), '-i', REAL, '-frames:v', '1', '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${Math.round(cell * ar)}:${cell}`, name(k)])
    }
    // uma coluna por instante: o quadro inteiro (480×270) e embaixo os três recortes
    const col = join(OUT, `col-${t}.png`)
    ffmpeg(['-i', name('inteiro'), '-i', name('pe'), '-i', name('quadrado'), '-i', name('mao'), '-filter_complex', `[1:v]pad=480:${cell}:(ow-iw)/2:0:black[a];[2:v]scale=${cell}:${cell},pad=480:${cell}:(ow-iw)/2:0:black[b];[3:v]pad=480:${cell}:(ow-iw)/2:0:black[c];[0:v][a][b][c]vstack=inputs=4`, '-frames:v', '1', col])
    tiles.push(col)
  }
  const rows = [tiles.slice(0, 4), tiles.slice(4)]
  const rowFiles = rows.map((files, i) => {
    const f = join(OUT, `linha-${i}.png`)
    ffmpeg([...files.flatMap((x) => ['-i', x]), '-filter_complex', `hstack=inputs=${files.length}`, '-frames:v', '1', f])
    return f
  })
  ffmpeg([...rowFiles.flatMap((x) => ['-i', x]), '-filter_complex', 'vstack=inputs=2', '-frames:v', '1', join(OUT, 'prancha-enquadramento.png')])
  console.log(`prancha em ${join(OUT, 'prancha-enquadramento.png')} (rosto em ${(track.boxes.length)} caixas)`)
})
