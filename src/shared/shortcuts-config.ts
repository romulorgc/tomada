import { z } from 'zod'

export type RecordingShortcuts = { recordStop: string; pause: string }
export const DEFAULT_RECORDING_SHORTCUTS: RecordingShortcuts = { recordStop: 'Ctrl+Shift+R', pause: 'Ctrl+Shift+P' }
const RESERVED = ['Ctrl+Alt+Space', 'Ctrl+Alt+Right', 'Ctrl+Alt+Left', 'Ctrl+Alt+Up', 'Ctrl+Alt+Down']
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Super']
const aliases: Record<string, string> = { control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Super', super: 'Super', meta: 'Super', space: 'Space', arrowleft: 'Left', left: 'Left', arrowright: 'Right', right: 'Right', arrowup: 'Up', up: 'Up', arrowdown: 'Down', down: 'Down' }

export function normalizeAccelerator(input: string): string {
  if (typeof input !== 'string' || input.length > 100) throw new Error('Escreva um atalho como Ctrl+Shift+R.')
  const parts = input.trim().split('+').map((p) => p.trim()).map((p) => aliases[p.toLowerCase()] ?? p.toUpperCase())
  const modifiers = parts.filter((p) => MODIFIERS.includes(p))
  const keys = parts.filter((p) => !MODIFIERS.includes(p))
  if (modifiers.length === 0 || new Set(modifiers).size !== modifiers.length || keys.length !== 1 || !/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Left|Right|Up|Down)$/.test(keys[0]!)) throw new Error('Use Ctrl, Alt ou Shift junto de uma letra, número ou tecla de função.')
  return [...MODIFIERS.filter((p) => modifiers.includes(p)), keys[0]!].join('+')
}

export const recordingShortcutsSchema = z.object({ recordStop: z.string().transform(normalizeAccelerator), pause: z.string().transform(normalizeAccelerator) })

export function validateRecordingShortcuts(input: unknown, retakeShortcut = 'Ctrl+Alt+Z'): RecordingShortcuts {
  const prefs = recordingShortcutsSchema.parse(input)
  if (prefs.recordStop === prefs.pause) throw new Error('Gravar/parar e pausar precisam de atalhos diferentes.')
  const retake = normalizeAccelerator(retakeShortcut)
  for (const value of Object.values(prefs)) {
    if (value === retake) throw new Error(`O atalho ${value} já está reservado para Errei.`)
    if (RESERVED.includes(value)) throw new Error(`O atalho ${value} já está reservado para o teleprompter.`)
  }
  return prefs
}

/** O mesmo acelerador no teclado local e no registro global do Electron. */
export function matchesAccelerator(event: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }, accelerator: string): boolean {
  const parts = normalizeAccelerator(accelerator).split('+')
  const key = event.key === ' ' ? 'Space' : aliases[event.key.toLowerCase()] ?? event.key.toUpperCase()
  return key === parts.at(-1) && event.ctrlKey === parts.includes('Ctrl') && event.altKey === parts.includes('Alt') && event.shiftKey === parts.includes('Shift') && event.metaKey === parts.includes('Super')
}
