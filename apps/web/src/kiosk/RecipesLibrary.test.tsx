import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { RecipesLibrary } from './RecipesLibrary'
import { TopbarSlotProvider } from './topbar-slot'
import type { Recipe } from '../lib/api'

// Drive the library off a fixed recipe set by mocking the data hook; everything
// else in the api slice stays real (the component only reads useRecipes here).
const recipesRef: { current: Recipe[] } = { current: [] }
// Saved plates are stubbed out too: the empty state below is only correct when BOTH
// halves of the unified library are known to be empty, so the test has to own both
// rather than race a real fetch that resolves to [] a tick later.
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    useRecipes: () => ({ recipes: recipesRef.current, loading: false, error: false }),
    useSavedMeals: () => ({ meals: [], loading: false, error: false, refetch: () => {} }),
  }
})

function makeRecipe(over: Partial<Recipe> & { id: string; title: string }): Recipe {
  return {
    emoji: null,
    description: null,
    category: null,
    tags: null,
    prepTimeMinutes: null,
    cookTimeMinutes: null,
    servings: 4,
    imageUrl: null,
    storageKey: null,
    sourceName: null,
    isFavorite: false,
    cookedCount: 0,
    lastCookedAt: null,
    mealType: null,
    protein: null,
    base: null,
    cuisine: null,
    effort: null,
    cookMethod: null,
    flavorProfile: null,
    dietary: [],
    vegetables: [],
    collection: null,
    ...over,
  }
}

function renderLib() {
  return render(
    <MemoryRouter initialEntries={['/meals/recipes']}>
      <TopbarSlotProvider>
        <Routes>
          <Route path="/meals/recipes" element={<RecipesLibrary />} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>,
  )
}

function cardFor(title: string): HTMLElement {
  return screen.getByText(title).closest('.recipes-card') as HTMLElement
}

describe('RecipesLibrary — New / never-cooked filter', () => {
  beforeEach(() => {
    recipesRef.current = [
      makeRecipe({ id: 'a', title: 'Fresh Salad', cookedCount: 0 }),
      makeRecipe({ id: 'b', title: 'Old Faithful Stew', cookedCount: 5 }),
    ]
  })

  it('shows both cooked and never-cooked recipes with the New toggle off', () => {
    renderLib()
    expect(screen.getByText('Fresh Salad')).toBeInTheDocument()
    expect(screen.getByText('Old Faithful Stew')).toBeInTheDocument()
  })

  it('shows only never-cooked recipes when the New toggle is on', () => {
    renderLib()
    fireEvent.click(screen.getByRole('button', { name: /New/i }))
    expect(screen.getByText('Fresh Salad')).toBeInTheDocument()
    expect(screen.queryByText('Old Faithful Stew')).not.toBeInTheDocument()
  })

  it('renders the 🆕 badge only on never-cooked cards', () => {
    renderLib()
    expect(within(cardFor('Fresh Salad')).getByText('🆕')).toBeInTheDocument()
    expect(within(cardFor('Old Faithful Stew')).queryByText('🆕')).not.toBeInTheDocument()
  })
})

// The old empty state read as a mistake: "0 of 0" over a search box, a sort and four
// filter dropdowns that could not narrow anything, plus a SECOND primary "＋ New
// recipe" jammed mid-sentence next to the one already in the topbar.
describe('RecipesLibrary — the empty library', () => {
  beforeEach(() => { recipesRef.current = [] })

  it('is one invitation, with exactly one primary button', () => {
    renderLib()
    expect(screen.getByText('No recipes yet')).toBeInTheDocument()
    // One call to action on the whole screen — the topbar's copy stands down.
    expect(screen.getAllByRole('button', { name: /new recipe/i })).toHaveLength(1)
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1)
  })

  it('drops the chrome that has nothing to work on', () => {
    renderLib()
    expect(screen.queryByLabelText(/search recipes and meals/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^sort$/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /favorites/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Collection')).not.toBeInTheDocument()
    // …and no "0 of 0", which was counting nothing against nothing.
    expect(screen.queryByText(/0 of 0/)).not.toBeInTheDocument()
  })

  it('keeps the search and filters the moment there is something to search', () => {
    recipesRef.current = [makeRecipe({ id: 'a', title: 'Fresh Salad' })]
    renderLib()
    expect(screen.getByLabelText(/search recipes and meals/i)).toBeInTheDocument()
    expect(screen.getByText('1 of 1')).toBeInTheDocument()
    expect(screen.queryByText('No recipes yet')).not.toBeInTheDocument()
  })

  it('says "nothing matches" rather than "no recipes" when a search misses', () => {
    recipesRef.current = [makeRecipe({ id: 'a', title: 'Fresh Salad' })]
    renderLib()
    fireEvent.change(screen.getByLabelText(/search recipes and meals/i), { target: { value: 'zzz' } })
    expect(screen.getByText(/nothing matches these filters/i)).toBeInTheDocument()
    // The way out stays on screen: the box you typed in, and Clear.
    expect(screen.getByLabelText(/search recipes and meals/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^clear$/i })).toBeInTheDocument()
  })
})
