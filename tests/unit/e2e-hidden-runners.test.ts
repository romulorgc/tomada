import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

test('o lançador limpo esconde o console do shell sem herdar ELECTRON_RUN_AS_NODE', () => {
  const runner = pathToFileURL(resolve('scripts/limpo.mjs')).href
  // Intercepta só a fronteira de spawn: executa o script real sem abrir seu filho.
  const program = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    childProcess.spawn = (command, options) => {
      process.stdout.write(JSON.stringify({ command, windowsHide: options.windowsHide, shell: options.shell, electronRunAsNode: options.env.ELECTRON_RUN_AS_NODE }));
      return new EventEmitter();
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'limpo.mjs', 'playwright', 'test'];
    await import(${JSON.stringify(runner)});
  `
  const data = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })) as { command: string; windowsHide?: boolean; shell: boolean; electronRunAsNode?: string }
  expect(data).toEqual({ command: 'playwright test', windowsHide: true, shell: true })
})

test('a fila esconde a consulta PowerShell e o shell filho antes de iniciar o trabalho', () => {
  const runner = pathToFileURL(resolve('scripts/fila-pesada.mjs')).href
  const program = `
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    const calls = [];
    // A trava é substituída na fronteira de filesystem: este ensaio não disputa
    // a trava real nem abre processos pesados/visíveis.
    fs.mkdirSync = () => undefined;
    fs.writeFileSync = () => undefined;
    childProcess.execFileSync = (command, args, options) => { calls.push({ command, windowsHide: options.windowsHide }); return '[]'; };
    childProcess.spawn = (command, args, options) => {
      calls.push({ command, windowsHide: options.windowsHide });
      process.stdout.write('AUDIT=' + JSON.stringify(calls));
      return new EventEmitter();
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'fila-pesada.mjs', 'npm', 'run', 'test:e2e'];
    await import(${JSON.stringify(runner)});
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', windowsHide: true })
  const calls = JSON.parse(output.split('AUDIT=')[1]!) as { command: string; windowsHide?: boolean }[]
  expect(calls).toEqual([{ command: 'powershell', windowsHide: true }, { command: 'npm', windowsHide: true }])
})
