import { useSustainedOffline } from '../../lib/pwa'
import { useI18n } from '../../lib/locale-provider'

// A quiet strip the kiosk shows when the network drops. The service worker keeps
// serving the last-known state, so this just tells the family what they're seeing.
// Debounced: only appears after a *sustained* outage (OFFLINE_BANNER_GRACE_MS),
// so reconnect blips don't flash it; it hides immediately when the network is back.
export function OfflineBanner() {
  const { t } = useI18n()
  const offline = useSustainedOffline()
  if (!offline) return null
  return (
    <div className="offline-banner" role="status">
      {t('status.offline')}
    </div>
  )
}
