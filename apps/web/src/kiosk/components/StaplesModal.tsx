import { useState, type FormEvent } from 'react'
import { groceryApi, type PantryStaple } from '../../lib/api'
import { useI18n } from '../../lib/locale-provider'

// Edit the household's pantry staples (assumed-in-house items left off the list).
export function StaplesModal({ staples, onClose, onChanged }: { staples: PantryStaple[]; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  async function add(e: FormEvent) {
    e.preventDefault()
    const name = draft.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      await groceryApi.addStaple(name)
      setDraft('')
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  async function remove(id: string) {
    await groceryApi.removeStaple(id)
    onChanged()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>{t('lists.staples')}</div>
        <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>
          Assumed in the house — the grocery list leaves these off.
        </div>

        <form onSubmit={add} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input className="set-inline-input" style={{ flex: 1, width: 'auto' }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('lists.staplePlaceholder')} />
          <button type="submit" className="btn btn-primary" disabled={!draft.trim() || busy}>{t('common.add')}</button>
        </form>

        <div className="grocery-staples">
          {staples.map((s) => (
            <span key={s.id} className="staple-chip editable">
              {s.name}
              <button type="button" aria-label={t('common.remove', { name: s.name })} onClick={() => remove(s.id)}>×</button>
            </span>
          ))}
          {staples.length === 0 && <div className="tiny muted" style={{ fontWeight: 600 }}>{t('lists.noStaples')}</div>}
        </div>
      </div>
    </div>
  )
}
