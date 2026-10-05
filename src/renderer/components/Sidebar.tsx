import type { ReactNode } from 'react'
import { t } from '../i18n/pt-BR'
import { useApp, type View } from '../store'
import { BrandMark, LibraryIcon, RecordIcon, SettingsIcon } from './Icons'

type NavItem = { name: View['name']; label: string; icon: ReactNode; testId: string }

const MAIN: NavItem[] = [
  { name: 'library', label: t.nav.library, icon: <LibraryIcon />, testId: 'nav-library' },
  { name: 'record', label: t.nav.record, icon: <RecordIcon />, testId: 'nav-record' }
]
const SETTINGS: NavItem = { name: 'settings', label: t.nav.settings, icon: <SettingsIcon />, testId: 'nav-settings' }

export function Sidebar() {
  const view = useApp((s) => s.view)
  const go = useApp((s) => s.go)

  // "Projeto aberto" ainda pertence à Biblioteca na navegação.
  const section: View['name'] = view.name === 'project' ? 'library' : view.name

  const item = (n: NavItem) => {
    const active = section === n.name
    const isRecord = n.name === 'record'
    return (
      <button
        key={n.name}
        type="button"
        data-testid={n.testId}
        aria-current={active ? 'page' : undefined}
        onClick={() => go({ name: n.name } as View)}
        className={[
          'group flex w-full items-center gap-3 rounded-control px-3 py-2 text-left text-[0.9375rem] font-medium transition-colors',
          active ? 'bg-raised text-ink' : 'text-muted hover:bg-surface hover:text-ink'
        ].join(' ')}
      >
        <span className={isRecord ? 'text-rec' : undefined}>{n.icon}</span>
        {n.label}
      </button>
    )
  }

  return (
    <aside className="flex w-[15rem] shrink-0 flex-col border-r border-line bg-panel px-3 pb-4 pt-5">
      <div className="mb-7 flex items-center gap-2.5 px-3 text-ink">
        <BrandMark />
        <span className="text-[1.0625rem] font-[650] tracking-[-0.01em]">{t.app.name}</span>
      </div>
      <nav aria-label={t.nav.label} className="flex flex-col gap-1">
        {MAIN.map(item)}
      </nav>
      <div className="mt-auto">{item(SETTINGS)}</div>
    </aside>
  )
}
