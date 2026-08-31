import { useSyncHealth } from '../../lib/powersync/sync-health'
import { useI18n } from '../../lib/locale-provider'

// A quiet strip for a wedged sync engine — the watchdog is already restarting it.
// Only the STALLED state shows: plain offline has its own banner, and a boot
// window is normal. While stalled the data hooks fall back to REST, so what's on
// screen is still current; this only explains why live updates may lag. Same
// shape as OfflineBanner.
export function SyncHealthBanner() {
  const { t } = useI18n()
  const health = useSyncHealth()
  if (health.status !== 'stalled') return null
  return (
    <div className="sync-banner" role="status">
      {t('status.syncing')}
    </div>
  )
}
