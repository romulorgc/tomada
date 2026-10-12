/**
 * Prova F2: grava `project.parsed.json` (o documento com os padrões aplicados) em cada pasta de F2_PROJECTS, para o laboratório de
 * render (`C:\tmp\tomada-f2-prova\tools\render.mjs`) usar. Só lê o que está na pasta; nada do usuário entra no repositório.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { test } from 'vitest'
import { parseProject } from '@shared/project'

const ROOT = process.env.F2_PROJECTS ?? 'C:/tmp/tomada-f2-prova/projetos'
test('parse dos projetos de prova', () => {
  for (const id of readdirSync(ROOT)) {
    try {
      writeFileSync(`${ROOT}/${id}/project.parsed.json`, JSON.stringify(parseProject(readFileSync(`${ROOT}/${id}/project.json`, 'utf8'))))
      console.log('parseado', id)
    } catch (e) {
      console.log('pulei', id, String(e).slice(0, 80))
    }
  }
})
