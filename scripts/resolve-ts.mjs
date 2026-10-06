// Gancho de resolução de módulos para os scripts .mjs que importam TypeScript de `src/` direto (o Node 24 tira os
// tipos, mas não completa a extensão): `import './script'` dentro de `src/shared/project.ts` vira `./script.ts`.
// Uso: `register('./resolve-ts.mjs', import.meta.url)` antes do `import()` dinâmico.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return await nextResolve(specifier + suffix, context)
        } catch {
          // tenta o próximo sufixo
        }
      }
    }
    throw err
  }
}
