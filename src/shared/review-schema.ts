import { z } from 'zod'

export const reviewItemSchema = z.looseObject({
  decision: z.enum(['pending', 'approved', 'discarded']).default('pending'), origin: z.enum(['auto', 'manual']).default('auto'),
  phase: z.enum(['queued', 'exporting', 'ready', 'error']).optional(), exportPath: z.string().optional(), textPath: z.string().optional(), error: z.string().optional(),
  captionsEnabled: z.boolean().optional(), captionStyle: z.enum(['natural', 'highlight', 'clean', 'karaoke']).optional(),
  layout: z.enum(['bubble','side-by-side','screen','camera','stack','screen-focus','screen-wide','presenter']).optional(), zoom: z.enum(['softer','stronger','off','auto']).optional(),
  trim: z.object({ start: z.number().nonnegative(), end: z.number().nonnegative() }).refine((r) => r.end > r.start).optional(),
  disabledReasons: z.array(z.enum(['silence','filler','retake','manual','ai'])).optional(), keepFillers: z.array(z.string().max(80)).max(30).optional(),
  disabledCutIds: z.array(z.string()).max(10000).optional(), disabledZoomIds: z.array(z.string()).max(10000).optional(), disabledLayoutIds: z.array(z.string()).max(10000).optional(), keptFillerCutIds: z.array(z.string()).max(10000).optional(),
  enabledCutIds:z.array(z.string()).max(10000).optional(), enabledReasons:z.array(z.enum(['silence','filler','retake','manual','ai'])).optional(),
  restoreAutoZooms:z.boolean().optional(),restoreAutoLayouts:z.boolean().optional(),
  revision: z.number().int().nonnegative().optional(),
  title: z.string().max(200).optional(), hook: z.string().max(200).optional(), text: z.string().max(10000).optional()
})
