import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MANIFEST_PATH, readManifest } from '../../src/main/manifest'
import { useTmpDir } from '../helpers/env'

// A leitura estrita do manifesto (M5a) também precisa conhecer os campos do piloto (M4d) e do estilo da câmera (M4c/df704fe):
// um valor torto não pode passar para o piloto nem para o processamento.
const tmp = useTmpDir('tomada-manifesto-piloto-')
const valid = { version: 1, sessionId: 's1', folder: 'g1', title: 'Gravação', createdAt: '2026-10-05T11:00:00Z', pauses: [], notes: [] }
async function write(extra: Record<string, unknown>): Promise<string> {
  const dir = tmp()
  await mkdir(join(dir, 'raw'), { recursive: true })
  await writeFile(join(dir, MANIFEST_PATH), JSON.stringify({ ...valid, ...extra }))
  return dir
}

it('aceita autopilotPending booleano e os dois estilos da câmera, e a ausência dos três', async () => {
  expect(await readManifest(await write({}))).toMatchObject({ sessionId: 's1' })
  expect(await readManifest(await write({ autopilotPending: true, cameraStyle: 'presenter' }))).toMatchObject({ autopilotPending: true, cameraStyle: 'presenter' })
  expect(await readManifest(await write({ autopilotPending: false, cameraStyle: 'side-by-side' }))).toMatchObject({ autopilotPending: false, cameraStyle: 'side-by-side' })
})

it('recusa a intenção do piloto que não é booleana', async () => {
  for (const bad of ['true', 1, null, {}]) await expect(readManifest(await write({ autopilotPending: bad }))).rejects.toThrow(/Intenção do piloto/)
})

it('recusa um estilo de câmera desconhecido (incluindo layouts que não são escolha de gravação)', async () => {
  for (const bad of ['bubble', 'stack', '', 1, null]) await expect(readManifest(await write({ cameraStyle: bad }))).rejects.toThrow(/Estilo da câmera/)
})
