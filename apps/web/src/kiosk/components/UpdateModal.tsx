import { useEffect, useState } from 'react'
import { updatesApi, useHousehold, type UpdateInfo } from '../../lib/api'
import '../../styles/update.css'
import { useI18n } from '../../lib/locale-provider'

// Once an admin dismisses a version, remember it so the modal never nags again
// until an even newer version ships. (Keyed by the release tag.)
const DISMISS_KEY = 'waffled.update.dismissed'

// App-wide "there's an update" modal, shown once per new release to admins only
// (only an admin can run the upgrade on the server, and the /api/updates endpoint
// is admin-gated). Mounted in KioskLayout so it can appear over any screen.
export function UpdateModal() {
  const { t } = useI18n()
  const { person } = useHousehold()
  const isAdmin = person?.isAdmin ?? false
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // Non-admins can't act on an update and the endpoint 403s them, so don't ask.
    if (!isAdmin) return
    let cancelled = false
    updatesApi
      .get()
      .then((r) => {
        if (cancelled) return
        setInfo(r)
        const tag = r.latest?.tag
        if (r.enabled && r.updateAvailable && tag && localStorage.getItem(DISMISS_KEY) !== tag) {
          setOpen(true)
        }
      })
      .catch(() => {}) // an update nudge is best-effort; never surface its errors
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  if (!open || !info?.latest) return null
  const { tag, url } = info.latest
  const display = tag.replace(/^v/i, '')
  const upgradeUrl = 'https://docs.waffled.app/operations/upgrading/'

  // "Remind me later" just closes for this session (reappears on next load);
  // the × / next-version logic remembers the tag so it won't return for this one.
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, tag)
    } catch {
      // localStorage can throw in private mode — closing is enough.
    }
    setOpen(false)
  }
  const snooze = () => setOpen(false)

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) snooze() }}>
      <div className="modal-card upd-card">
        <button type="button" className="modal-close" aria-label={t('update.dismiss')} onClick={dismiss}>×</button>
        <div className="upd-badge">🧇</div>
        <div className="upd-eyebrow">{t('update.available')}</div>
        <h2 className="upd-title wf-serif">{t('update.here', { version: display })}</h2>
        <div className="upd-ver">{t('update.current', { version: info.current.version })}</div>

        <div className="upd-cmd">
          <div className="upd-cmd-l">{t('update.command')}</div>
          <code>./waffled upgrade</code>
        </div>

        <div className="upd-actions">
          <a className="btn btn-ghost" href={url} target="_blank" rel="noopener noreferrer">{t('update.changelog')}</a>
          <a className="btn btn-primary" href={upgradeUrl} target="_blank" rel="noopener noreferrer">{t('update.how')}</a>
        </div>
        <button type="button" className="upd-later" onClick={snooze}>{t('update.later')}</button>
      </div>
    </div>
  )
}
