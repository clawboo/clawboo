// One way to make a Home write: run it, and when it fails say why. A write the
// server's person check refused gets the same notice the Board gives; anything
// else gets a short "Couldn't ..." toast. The caller gets the result, or null.

import { HomeRequestError } from '@clawboo/control-client'

import { notePersonCheck, PERSON_CHECK_REFUSED } from '@/lib/personCheckNotice'
import { useToastStore } from '@/stores/toast'

/** Why a write was refused, in words, for the server's refusal codes a person
 *  can act on (`HomeRefusal` in packages/db/src/home/types.ts). */
const CODE_WORDS: Record<string, string> = {
  team_not_found: 'That team is gone.',
  goal_not_found: 'That goal is gone: someone removed it.',
  kpi_not_found: 'That KPI is gone: someone removed it.',
  page_not_found: 'That page is gone: someone removed it.',
  update_not_found: 'That update is gone: someone removed it.',
  revision_not_found: 'That revision is gone.',
  invalid_parent: 'That goal cannot go under the one picked.',
  parent_has_parent: 'A goal under another goal cannot have goals under it.',
  goal_has_children: 'This goal has goals under it, so it cannot go under another goal.',
  goal_other_team: 'That goal belongs to another team.',
  goal_archived: 'That goal is archived.',
  empty: 'Give it a title first.',
  too_long: 'That is too long.',
  too_many: 'This team has as many of these as Home keeps.',
  not_draft: 'That update is no longer a draft: someone published or discarded it.',
  not_suggested: 'That suggestion was already accepted or dismissed.',
  not_active: 'That KPI is archived.',
  wrong_source: 'Only a KPI a person types takes values by hand.',
  archived: 'That is archived.',
}

export async function homeWrite<T>(
  what: string,
  write: () => Promise<T>,
  opts: { success?: string } = {},
): Promise<T | null> {
  const toast = useToastStore.getState().addToast
  try {
    const result = await write()
    if (opts.success) toast({ type: 'success', message: opts.success })
    return result
  } catch (err) {
    if (err instanceof HomeRequestError && err.code === 'person_only') {
      notePersonCheck(PERSON_CHECK_REFUSED)
      return null
    }
    const code = err instanceof HomeRequestError ? err.code : null
    toast({
      type: 'error',
      message: (code && CODE_WORDS[code]) || `Couldn’t ${what}. Please try again.`,
    })
    return null
  }
}
