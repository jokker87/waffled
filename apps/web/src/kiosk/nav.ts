import type { IconName } from './icons'
import type { ModuleKey } from '../lib/modules'

// The rail's primary nav. `path` drives both the route and the active state.
// `module` (optional) gates the entry behind an enabled optional module.
export interface Screen {
  path: string
  label: string
  labelKey: string
  icon: IconName
  module?: ModuleKey
}

export const SCREENS: Screen[] = [
  { path: '/', label: 'Today', labelKey: 'nav.today', icon: 'home' },
  { path: '/calendar', label: 'Calendar', labelKey: 'nav.calendar', icon: 'calendar' },
  { path: '/tasks', label: 'Tasks', labelKey: 'nav.tasks', icon: 'tasks', module: 'chores' },
  { path: '/goals', label: 'Goals', labelKey: 'nav.goals', icon: 'goals', module: 'goals' },
  { path: '/family', label: 'Family', labelKey: 'nav.family', icon: 'family' },
  { path: '/meals', label: 'Meals', labelKey: 'nav.meals', icon: 'meals', module: 'meals' },
  { path: '/lists', label: 'Lists', labelKey: 'nav.lists', icon: 'lists', module: 'lists' },
  { path: '/pantry', label: 'Pantry', labelKey: 'nav.pantry', icon: 'pantry', module: 'pantry' },
  { path: '/photos', label: 'Photos', labelKey: 'nav.photos', icon: 'photos' },
]

export const SETTINGS: Screen = { path: '/settings', label: 'Settings', labelKey: 'nav.settings', icon: 'settings' }
