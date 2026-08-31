import { NavLink, Link } from 'react-router'
import { Icon } from '../icons'
import { SCREENS, SETTINGS, type Screen } from '../nav'
import { isKioskMode, authApi, useHousehold } from '../../lib/api'
import { moduleEnabled } from '../../lib/modules'
import { useI18n } from '../../lib/locale-provider'

function railClass({ isActive }: { isActive: boolean }) {
  return `rail-item ${isActive ? 'on' : ''}`
}

// Bottom-of-rail account chip: always shows who's signed in. In kiosk mode it's a
// one-tap return to the profile picker ("Switch"); otherwise it shows the person's
// name and links to Settings (account).
function RailAccount({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n()
  const { person } = useHousehold()
  const avatar = (
    <span
      className="rail-switch-av"
      style={{ background: person?.colorHex ? `${person.colorHex}22` : 'var(--panel)' }}
    >
      {person?.avatarEmoji ?? '🙂'}
    </span>
  )

  if (isKioskMode()) {
    return (
      <button className="rail-switch" onClick={() => { onNavigate?.(); void authApi.logout() }} title={t('nav.switchProfile')}>
        {avatar}
        <span className="rail-switch-label">{t('nav.switch')}</span>
      </button>
    )
  }

  if (!person) return null
  const firstName = person.name?.split(' ')[0] || person.name
  return (
    <Link to="/settings" className="rail-switch" title={t('nav.signedInAs', { name: person.name })} onClick={onNavigate}>
      {avatar}
      <span className="rail-switch-label">{firstName}</span>
    </Link>
  )
}

function RailLink({ screen, onNavigate }: { screen: Screen; onNavigate?: () => void }) {
  const { t } = useI18n()
  return (
    <NavLink to={screen.path} end={screen.path === '/'} className={railClass} onClick={onNavigate}>
      <Icon name={screen.icon} />
      {t(screen.labelKey)}
    </NavLink>
  )
}

export function Rail({ mobileOpen = false, onNavigate }: { mobileOpen?: boolean; onNavigate?: () => void }) {
  const { t } = useI18n()
  const { household } = useHousehold()
  // Hide nav entries for optional modules the household hasn't enabled.
  const screens = SCREENS.filter((s) => !s.module || moduleEnabled(household, s.module))
  return (
    <nav id="primary-navigation" className={`rail${mobileOpen ? ' mobile-open' : ''}`} aria-label={t('nav.primary')}>
      <Link to="/" className="rail-logo" aria-label={t('nav.home')} onClick={onNavigate}><img src="/logo.png" alt="Waffled" /></Link>
      {screens.map((s) => (
        <RailLink key={s.path} screen={s} onNavigate={onNavigate} />
      ))}
      <div className="rail-spacer" />
      <RailAccount onNavigate={onNavigate} />
      <RailLink screen={SETTINGS} onNavigate={onNavigate} />
    </nav>
  )
}
