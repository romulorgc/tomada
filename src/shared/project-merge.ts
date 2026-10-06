import type { Project } from './types'
const equal = (a:unknown,b:unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Três fotografias: só alterações do editor substituem o estado que chegou enquanto ele estava aberto. */
export function mergeEditorProject(base:Project,edited:Project,current:Project):Project {
  const merge = (before:unknown,next:unknown,fresh:unknown):unknown => {
    if(equal(before,next)) return fresh
    if(Array.isArray(before) && Array.isArray(next) && Array.isArray(fresh) && [...before,...next,...fresh].every((v) => v && typeof v === 'object' && typeof v.id === 'string')) {
      const removed = new Set(before.filter((v) => !next.some((n) => n.id === v.id)).map((v) => v.id))
      const changed = next.filter((v) => !equal(before.find((b) => b.id === v.id),v))
      const replacements = new Map(changed.map((v) => [v.id,v]))
      const merged = [...fresh.filter((v) => !removed.has(v.id)).map((v) => replacements.get(v.id) ?? v),...changed.filter((v) => !fresh.some((f) => f.id === v.id))]
      const order = new Map(next.map((v,index) => [v.id,index]))
      return merged.sort((a,b) => typeof a.start === 'number' && typeof b.start === 'number' ? a.start-b.start : (order.get(a.id) ?? next.length)-(order.get(b.id) ?? next.length))
    }
    if(before && next && fresh && !Array.isArray(next) && typeof before === 'object' && typeof next === 'object' && typeof fresh === 'object') {
      const old = before as Record<string,unknown>, value = next as Record<string,unknown>, result = {...fresh as Record<string,unknown>}
      for(const key of new Set([...Object.keys(old),...Object.keys(value)])) {
        if(equal(old[key],value[key])) continue
        if(!Object.hasOwn(value,key)) delete result[key]
        else result[key] = merge(old[key],value[key],result[key])
      }
      return result
    }
    return next
  }
  return merge(base,edited,current) as Project
}
