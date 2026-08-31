import { useState, type FormEvent } from 'react'
import { Icon } from '../icons'
import { useGrocery } from '../../lib/api'
import { useI18n } from '../../lib/locale-provider'

// Real, interactive grocery list: tap to check off, type to add. Backed by
// /api/lists/grocery.
export function GroceryCard() {
  const { t } = useI18n()
  const { items, loading, error, add, toggle, remove } = useGrocery()
  const [draft, setDraft] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    const name = draft.trim()
    if (!name) return
    setDraft('')
    await add(name)
  }

  return (
    <div className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <div className="card-h" style={{ fontSize: 17 }}>
          {t('grocery.title')}
        </div>
        <div style={{ marginLeft: 'auto' }} className="ai-tag">
          <Icon name="spark" />
          {t('grocery.auto')}
        </div>
      </div>

      {loading && <div className="tiny muted">{t('common.loading')}</div>}
      {error && <div className="tiny muted">{t('grocery.error')}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="tiny muted" style={{ paddingBottom: 6 }}>{t('grocery.empty')}</div>
      )}

      <div className="gc-scroll">
        {items.map((item) => (
          <div key={item.id} className="gitem" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
            <button
              type="button"
              onClick={() => toggle(item.id, !item.checked)}
              aria-label={t('common.toggle', { name: item.name })}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flex: 1,
                minWidth: 0,
                background: 'none',
                border: 0,
                padding: 0,
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span className={`gcheck ${item.checked ? 'on' : ''}`} />
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  textDecoration: item.checked ? 'line-through' : 'none',
                  color: item.checked ? 'var(--ink-3)' : 'var(--ink)',
                }}
              >
                {item.name}
              </span>
            </button>
            <button
              type="button"
              className="gitem-del"
              onClick={() => remove(item.id)}
              aria-label={t('common.remove', { name: item.name })}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {!error && (
        <form onSubmit={submit} style={{ paddingTop: 8 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('grocery.addItem')}
            aria-label={t('grocery.addItemLabel')}
            style={{
              width: '100%',
              border: '2px dashed var(--hair)',
              borderRadius: 'var(--r-md)',
              padding: '9px 12px',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--ink)',
              background: 'transparent',
              fontFamily: 'var(--sans)',
            }}
          />
        </form>
      )}
    </div>
  )
}
