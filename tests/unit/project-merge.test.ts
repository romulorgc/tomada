import { expect,it } from 'vitest'
import { createProject } from '../../src/shared/project'
import { mergeEditorProject } from '../../src/shared/project-merge'
import { createEditorStore } from '../../src/shared/editor-store'
it('salvar estilo no editor antigo conserva cortes, clipes e textos gerados em segundo plano',() => {
  const base = createProject({title:'Teste'})
  const fresh = {...base,cuts:[{id:'auto-novo',start:100,end:300,reason:'silence' as const,enabled:true,origin:'auto' as const}],meta:{youtube:{description:'Pronto'}}}
  const edited = {...base,style:{...base.style,radius:25}}
  const merged = mergeEditorProject(base,edited,fresh)
  expect(merged.cuts).toEqual(fresh.cuts);expect(merged.meta).toEqual(fresh.meta)
  expect(merged.style.radius).toBe(25)
})
it('desfazer um ajuste já salvo usa a última fotografia submetida e conserva automáticos novos',async () => {
  const base = createProject({title:'Teste'})
  let fresh:typeof base = {...base,cuts:[{id:'auto-novo',start:100,end:300,reason:'silence' as const,enabled:true,origin:'auto' as const}]}
  const store = createEditorStore({project:base,save:async (edited,lastSubmitted?:typeof base) => {
    fresh = mergeEditorProject(lastSubmitted ?? base,edited,fresh)
    return fresh
  }})
  try {
    store.getState().change((p) => ({...p,style:{...p.style,radius:25}}))
    await store.getState().flush()
    expect(fresh.style.radius).toBe(25)
    store.getState().undo()
    await store.getState().flush()
    expect(fresh.style.radius).toBe(base.style.radius)
    expect(fresh.cuts.map((c) => c.id)).toEqual(['auto-novo'])
    store.getState().redo()
    await store.getState().flush()
    expect(fresh.style.radius).toBe(25)
  } finally { store.getState().dispose() }
})
it('alterar ou apagar um segmento específico preserva os novos que chegaram depois',() => {
  const base = createProject({title:'Teste'})
  base.layouts = [{id:'antigo',start:0,end:1000,layout:'bubble',origin:'auto'}]
  const fresh = {...base,layouts:[...base.layouts,{id:'novo',start:2000,end:3000,layout:'screen' as const,origin:'auto' as const}]}
  expect(mergeEditorProject(base,{...base,layouts:[]},fresh).layouts.map((s) => s.id)).toEqual(['novo'])
  expect(mergeEditorProject(base,{...base,layouts:[{...base.layouts[0]!,layout:'camera',origin:'manual'}]},fresh).layouts).toContainEqual(fresh.layouts[1])
})
it('editar e desfazer exclusão de corte preserva a ordem dos cartões e o corte novo em segundo plano',() => {
  const base = createProject({title:'Teste'})
  base.clips = ['a','b','c'].map((id) => ({id,title:id,hook:'Gancho',ranges:[{start:0,end:20000}],score:80,reason:'Valor',format:'vertical',layoutV:'auto',source:'ai'}))
  const fresh = {...base,clips:[...base.clips,{...base.clips[0]!,id:'d'}]}
  const edited = {...base,clips:[{...base.clips[0]!,title:'Ajustado'},...base.clips.slice(1)]}
  const saved = mergeEditorProject(base,edited,fresh)
  expect(saved.clips.map((c) => c.id)).toEqual(['a','b','c','d'])
  expect(saved.clips[0]?.title).toBe('Ajustado')
  const deleted = {...base,clips:base.clips.slice(1)}
  const deletedFresh = {...fresh,clips:fresh.clips.slice(1)}
  expect(mergeEditorProject(deleted,base,deletedFresh).clips.map((c) => c.id)).toEqual(['a','b','c','d'])
})
