import { useNavigate } from 'react-router'
import { useTopbarRight } from './topbar-slot'
import { useFamilyOverview, type FamilyMember } from '../lib/api'
import './../styles/overview.css'
import { useI18n } from '../lib/locale-provider'

function MemberCard({ m, onOpen }: { m: FamilyMember; onOpen: () => void }) {
  const { t } = useI18n()
  return (
    <button type="button" className="card fam-card" onClick={onOpen}>
      <div className="fam-head">
        <span className="fam-av" style={{ background: m.colorHex ? `${m.colorHex}22` : 'var(--panel)' }}>{m.avatarEmoji ?? '🙂'}</span>
        <div className="fam-name-wrap">
          <div className="fam-name">{m.name}</div>
          {m.age != null && <div className="tiny muted" style={{ fontWeight: 600 }}>{t('family.age', { age: m.age })}</div>}
        </div>
        {m.topStreak >= 2 && <span className="fam-streak">🔥 {m.topStreak}</span>}
      </div>
      <div className="fam-stats">
        <div className="fam-stat">
          <div className="fam-stat-n">{m.activeGoals}</div>
          <div className="fam-stat-l">{t('family.goals')}</div>
        </div>
        <div className="fam-stat">
          <div className="fam-stat-n">{m.avgProgressPct}%</div>
          <div className="fam-stat-l">{t('family.progress')}</div>
        </div>
        <div className="fam-stat">
          <div className="fam-stat-n" style={{ color: 'var(--person-4)' }}>⭐ {m.stars}</div>
          <div className="fam-stat-l">{t('family.stars')}</div>
        </div>
      </div>
      <div className="fam-bar"><span style={{ width: `${m.avgProgressPct}%` }} /></div>
    </button>
  )
}

export function FamilyOverview() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { people, loading, error } = useFamilyOverview()

  useTopbarRight(
    () => (
      <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/goals')}>🎯 {t('nav.goals')}</button>
    ),
    [navigate, t]
  )

  if (loading) return <div className="muted" style={{ padding: 30 }}>{t('common.loading')}</div>
  if (error) return <div className="muted" style={{ padding: 30 }}>{t('family.error')}</div>

  return (
    <div className="family-overview">
      <div className="fam-title wf-serif">{t('family.title')}</div>
      <div className="fam-grid">
        {people.map((m) => (
          <MemberCard key={m.personId} m={m} onOpen={() => navigate(`/person/${m.personId}`)} />
        ))}
      </div>
    </div>
  )
}
