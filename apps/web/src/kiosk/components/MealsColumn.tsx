import { Link, useNavigate } from 'react-router'
import { useMealsWeek, localToday, type WeekEntry } from '../../lib/api'
import { useI18n } from '../../lib/locale-provider'

function dayAbbrev(dateStr: string, locale: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(locale, { weekday: 'short' })
}

// A meal can be eating-out (no cooking) — detected from a recipe-less title.
export function isEatingOut(entry: { recipeId: string | null; title: string | null }): boolean {
  return !entry.recipeId && /\b(eating|eat|dining|going)\s*out|take\s*-?out|order(ing)?\s+in|delivery|takeaway\b/i.test(entry.title ?? '')
}

// A recipe-less "Leftovers" night.
export function isLeftovers(entry: { recipeId: string | null; title: string | null }): boolean {
  return !entry.recipeId && /^\s*leftovers\s*$/i.test(entry.title ?? '')
}

// A recipe-less "Try something new" night — a nudge to cook a brand-new dish.
export function isTryNew(entry: { recipeId: string | null; title: string | null }): boolean {
  return !entry.recipeId && /try something new|try new/i.test(entry.title ?? '')
}

// Tonight's dinner — works whether it's a recipe, a recipe-less ("Fish") plan, or
// an eating-out night. Never vanishes when something is planned.
function TonightCard({ entry }: { entry: WeekEntry }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const recipe = entry.recipe
  const recipeId = entry.recipeId
  const title = recipe?.title ?? entry.title ?? t('meals.dinners')
  const eatingOut = isEatingOut(entry)
  const tryNew = isTryNew(entry)
  const emoji = recipe?.emoji ?? (eatingOut ? '🍴' : tryNew ? '✨' : '🍽️')

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 112, background: eatingOut ? 'linear-gradient(135deg,#d9e7f6,#bcd0e9)' : tryNew ? 'linear-gradient(135deg,#efdcf3,#d9bce9)' : 'linear-gradient(135deg,#f6d9c6,#e9b596)', position: 'relative' }}>
        <div style={{ position: 'absolute', right: 12, top: 10, fontSize: 34 }}>{emoji}</div>
      </div>
      <div style={{ padding: '14px 16px 15px' }}>
        <div className="tiny" style={{ color: 'var(--person-4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
          {t('meals.tonightDinner')}
        </div>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, margin: '3px 0 6px' }}>
          {eatingOut ? t('meals.eatingOut') : tryNew ? t('meals.tryNew') : title}
        </div>

        {/* A plate gets the same two actions a recipe does — open it, or cook it —
            pointed at the plate routes. Without this branch a planned meal fell
            through to "No recipe attached yet", which was simply untrue. */}
        {!recipeId && entry.mealId ? (
          <>
            <div className="tiny muted" style={{ display: 'flex', gap: 14 }}>
              <span>🍽️ {t('meals.meal')} · {entry.meal?.recipes.length ?? 0}</span>
              {entry.meal?.servings != null && <span>{t('meals.serves', { count: entry.meal.servings })}</span>}
            </div>
            <div style={{ display: 'flex', gap: 9, paddingTop: 13 }}>
              <button className="btn btn-ghost" onClick={() => navigate(`/meals/build/${entry.mealId}`)} style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10, cursor: 'pointer' }}>
                {t('meals.viewMeal')}
              </button>
              <button className="btn btn-primary" onClick={() => navigate(`/meals/meal/${entry.mealId}/cook`)} title={t('meals.cookWhole')} style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10, cursor: 'pointer' }}>
                {t('meals.cookMode')}
              </button>
            </div>
          </>
        ) : recipeId ? (
          <>
            <div className="tiny muted" style={{ display: 'flex', gap: 14 }}>
              {recipe?.cookTimeMinutes != null && <span>🕐 {recipe.cookTimeMinutes} min</span>}
              {recipe?.servings != null && <span>🍽️ {t('meals.serves', { count: recipe.servings })}</span>}
            </div>
            <div style={{ display: 'flex', gap: 9, paddingTop: 13 }}>
              <button className="btn btn-ghost" onClick={() => navigate(`/meals/recipe/${recipeId}`)} style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10, cursor: 'pointer' }}>
                {t('meals.viewRecipe')}
              </button>
              <button className="btn btn-primary" onClick={() => navigate(`/meals/recipe/${recipeId}/cook`)} title={t('meals.cookSteps')} style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10, cursor: 'pointer' }}>
                {t('meals.cookMode')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="tiny muted" style={{ paddingBottom: 2 }}>
              {eatingOut ? `${t('meals.noCooking')} 🎉` : tryNew ? t('meals.newTime') : t('meals.noRecipe')}
            </div>
            <div style={{ display: 'flex', gap: 9, paddingTop: 13 }}>
              <button className="btn btn-ghost" onClick={() => navigate('/meals')} style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10, cursor: 'pointer' }}>
                {eatingOut ? t('meals.changePlan') : t('meals.findRecipe')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Tonight's dinner as a standalone Today card (self-fetching). Renders nothing
// when nothing is planned for today, so it can sit in the draggable board.
export function TonightCardSlot() {
  const { entries } = useMealsWeek()
  const tonight = entries.find((e) => e.mealType === 'dinner' && e.date === localToday()) ?? null
  if (!tonight) return null
  return <TonightCard entry={tonight} />
}

// "This week's dinners" as a standalone Today card (self-fetching).
export function WeekDinnersCard() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const { entries, loading, error } = useMealsWeek()
  const dinners = entries.filter((e) => e.mealType === 'dinner')
  return (
    <div className="card" style={{ padding: '15px 18px 8px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <Link to="/meals" className="card-h" style={{ fontSize: 16, textDecoration: 'none', color: 'inherit' }}>
          {t('meals.weekDinners')}
        </Link>
        <Link to="/meals" className="tiny muted" style={{ marginLeft: 'auto', textDecoration: 'none', color: 'var(--ink-2)' }}>
          {t('meals.plannedCount', { count: dinners.length })}
        </Link>
      </div>
      {loading && <div className="tiny muted" style={{ padding: '6px 0' }}>{t('common.loading')}</div>}
      {error && <div className="tiny muted" style={{ padding: '6px 0' }}>{t('meals.loadError')}</div>}
      {!loading && !error && dinners.length === 0 && (
        <div className="tiny muted" style={{ padding: '6px 0' }}>{t('meals.noDinners')}</div>
      )}
      {dinners.map((e: WeekEntry) => {
        // A slot holds EITHER a recipe or a whole plate — both are somewhere to go.
        const clickable = !!e.recipeId || !!e.mealId
        const out = isEatingOut(e)
        const tryNew = isTryNew(e)
        return (
          <div
            key={e.id}
            onClick={() => clickable && navigate(e.mealId ? `/meals/build/${e.mealId}` : `/meals/recipe/${e.recipeId}`)}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            title={clickable ? t(e.mealId ? 'meals.openMeal' : 'meals.openRecipe') : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '6px 0', borderBottom: '1px solid var(--hair-2)', cursor: clickable ? 'pointer' : 'default' }}
          >
            <div className="tiny" style={{ width: 34, fontWeight: 700, color: 'var(--ink-2)' }}>
              {dayAbbrev(e.date, locale)}
            </div>
            <div style={{ fontSize: 16, width: 22, textAlign: 'center' }}>{e.recipe?.emoji ?? (out ? '🍴' : tryNew ? '✨' : '🍽️')}</div>
            <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{out ? t('meals.eatingOut') : tryNew ? t('meals.tryNew') : e.recipe?.title ?? e.title ?? t('meals.planned')}</div>
            {clickable && <div className="tiny muted" style={{ fontSize: 16 }}>›</div>}
          </div>
        )
      })}
    </div>
  )
}

// The original combined meals column (Tonight + week), composed from the two
// slots above. Kept for any non-customizable surface and the unit tests.
export function MealsColumn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      <TonightCardSlot />
      <WeekDinnersCard />
    </div>
  )
}
