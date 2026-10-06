import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, test, vi } from 'vitest'

// Executa a ligação REAL do store sem inicializar Electron. Só a fronteira shell
// é substituída: o RED nunca abre Explorer no computador que o usuário está usando.
const source = ts.createSourceFile('index.ts', readFileSync(resolve('src/main/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
let binding: ts.Expression | undefined
function visit(node: ts.Node): void {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'openFolder') binding = node.initializer
  ts.forEachChild(node, visit)
}
visit(source)
if (!binding) throw new Error('Não encontrei a ligação openFolder do store.')
const program = ts.transpileModule(`const openFolder = ${binding.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function setup(testMode: boolean, hidden: boolean) {
  const shell = { openPath: vi.fn(async (_path: string) => '') }
  const calls: { op: string; path: string }[] = []
  const open = new Function('shell', 'testMode', 'isE2eHidden', 'testCalls', `${program}\nreturn openFolder`)(shell, testMode, () => hidden, () => calls) as (path: string) => Promise<void>
  return { shell, calls, open }
}

test.each([{ testMode: true, hidden: false }, { testMode: false, hidden: true }])('Abrir pasta registra a intenção sem Explorer em modo $testMode/oculto $hidden', async ({ testMode, hidden }) => {
  const s = setup(testMode, hidden)
  await s.open('C:\\projetos\\exemplo')
  expect(s.shell.openPath).not.toHaveBeenCalled()
  expect(s.calls).toEqual([{ op: 'open', path: 'C:\\projetos\\exemplo' }])
})

test('Abrir pasta conserva o shell real no modo normal', async () => {
  const s = setup(false, false)
  await s.open('C:\\projetos\\exemplo')
  expect(s.shell.openPath).toHaveBeenCalledWith('C:\\projetos\\exemplo')
  expect(s.calls).toEqual([])
})

test('Abrir pasta conserva a mensagem do erro nativo no modo normal', async () => {
  const s = setup(false, false)
  s.shell.openPath.mockResolvedValue('pasta indisponível')
  await expect(s.open('C:\\projetos\\exemplo')).rejects.toThrow('Não consegui abrir a pasta: pasta indisponível')
})
