import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** Sintético a 250 qps: ±80 ms exatos, sem confundir a medição com um quadro de 30 qps. */
export function makeCameraSyncRaw(dir: string, offsetMs: number, unequalStart = false, beepAtMs = 1000): string {
  const raw = join(dir, 'camera-bruta.mkv')
  const videoStart = unequalStart ? 0.2 : 0
  const audioStart = unequalStart ? 0.28 : 0
  const beep = beepAtMs / 1000
  const flash = beep + offsetMs / 1000
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=160x90:r=250:d=3,drawbox=color=white:t=fill:enable='between(t,${flash.toFixed(3)},${(flash + 0.12).toFixed(3)})',setpts=PTS+${videoStart}/TB`,
    '-f', 'lavfi', '-i', `aevalsrc='0.5*sin(2*PI*1000*t)*between(t,${beep.toFixed(3)},${(beep + 0.12).toFixed(3)})':s=48000:d=3,asetpts=PTS+${audioStart}/TB`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-copyts', raw
  ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return raw
}
