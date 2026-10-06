import { z } from 'zod'
import type { CaptionStyle, Project, ZoomPresetId } from './types'

export const exportDefaultsSchema = z.object({
  horizontal: z.object({ resolution: z.enum(['1080p', '1440p', '2160p']).default('1080p'), fps: z.union([z.literal(30), z.literal(60)]).default(30) }).prefault({}),
  vertical: z.object({ fps: z.union([z.literal(30), z.literal(60)]).default(30) }).prefault({})
})
export type ExportDefaults = z.infer<typeof exportDefaultsSchema>
export const DEFAULT_EXPORT_DEFAULTS: ExportDefaults = { horizontal: { resolution: '1080p', fps: 30 }, vertical: { fps: 30 } }
export const zoomPreferenceSchema = z.enum(['off', 'subtle', 'moderate', 'intense'])
export const ownerCaptionSchema = z.object({
  enabled: z.boolean(), style: z.enum(['natural', 'highlight', 'clean', 'karaoke']), wordsPerLine: z.number().int().min(1).max(6), position: z.enum(['bottom', 'center', 'top']), box: z.boolean(),
  highlightColor: z.string().regex(/^#[0-9a-f]{6}$/i), textColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), size: z.number().min(0.6).max(1.5).optional(), positionY: z.number().min(0.04).max(0.96).optional(), uppercase: z.boolean().optional(), highlightWord: z.boolean().optional()
})
export const ownerVerticalCaptionSchema = ownerCaptionSchema.extend({ wordsPerLine: z.number().int().min(1).max(3) })
export const onboardingPrefsSchema = z.object({ dismissedFingerprint: z.string().max(1000).optional(), completedAt: z.string().datetime().optional(), withoutAi: z.boolean().optional() })
export type OnboardingPrefs = z.infer<typeof onboardingPrefsSchema>
export type OwnerEditingDefaults = {
  ownerCaptionsHorizontal?: CaptionStyle
  ownerCaptionsVertical?: CaptionStyle
  ownerZoomPreset?: ZoomPresetId | 'off'
  ownerVerticalZoomPreset?: ZoomPresetId | 'off'
}

/** Só no nascimento de um projeto: depois disso cada edição pertence ao documento. */
export function applyOwnerEditingDefaults(project: Project, prefs: OwnerEditingDefaults): Project {
  const result: Project = { ...project, captions: { ...project.captions, ...prefs.ownerCaptionsHorizontal }, ...(prefs.ownerZoomPreset ? { zoomPreset: prefs.ownerZoomPreset } : {}) }
  if (prefs.ownerCaptionsVertical || prefs.ownerVerticalZoomPreset) result.vertical = { layout: 'screen-focus', layouts: [], zooms: [], ...project.vertical, ...(prefs.ownerCaptionsVertical ? { captions: { ...prefs.ownerCaptionsVertical } } : {}), ...(prefs.ownerVerticalZoomPreset ? { zoomPreset: prefs.ownerVerticalZoomPreset } : {}) }
  return result
}
