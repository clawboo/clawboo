// A team's pages: markdown with every revision kept. A person or an agent (the
// Tasks tool `write_page`) writes a new revision; nothing is overwritten, and a
// revert is a new revision that copies an old one, so a person can always undo
// an agent's edit.

import { randomUUID } from 'node:crypto'

import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { immediateWrite, type BoardTx } from '../board/contention'
import { appendEvent } from '../events/appendEvent'
import {
  teamGoals,
  teamPageRevisions,
  teamPages,
  type DbTeamPage,
  type DbTeamPageRevision,
} from '../schema'
import { teamExistsForHome } from './goals'
import {
  actorJson,
  cleanTitle,
  done,
  AGENT_PAGE_BODY_MAX_CHARS,
  AGENT_PAGE_REVISION_CAP,
  AGENT_PAGE_REVISIONS_PER_HOUR,
  AGENT_PAGES_PER_DAY,
  DAY_MS,
  MAX_PAGES_PER_TEAM,
  PAGE_BODY_MAX_CHARS,
  PAGE_REVISIONS_LIST_DEFAULT,
  PAGE_REVISIONS_LIST_MAX,
  parseActor,
  refuse,
  type HomeActor,
  type HomeResult,
} from './types'

export interface TeamPageRecord {
  id: string
  teamId: string
  goalId: string | null
  title: string
  pinned: boolean
  archivedAt: number | null
  createdAt: number
  updatedAt: number
  revision: number
  updatedBy: HomeActor | null
}

/** A revision without its words. */
export interface TeamPageRevisionMetaRecord {
  id: string
  pageId: string
  revision: number
  title: string
  bodyChars: number
  author: HomeActor | null
  executionId: string | null
  revertedFrom: number | null
  createdAt: number
}

export interface TeamPageRevisionRecord extends TeamPageRevisionMetaRecord {
  body: string
}

export interface TeamPageWithBodyRecord extends TeamPageRecord {
  body: string
}

export function toRevisionRecord(row: DbTeamPageRevision): TeamPageRevisionRecord {
  return {
    id: row.id,
    pageId: row.pageId,
    revision: row.revision,
    title: row.title,
    bodyChars: row.body.length,
    body: row.body,
    author: parseActor(row.author),
    executionId: row.executionId ?? null,
    revertedFrom: row.revertedFrom ?? null,
    createdAt: row.createdAt,
  }
}

/** What a page's listing needs of its newest revision: never its words. */
interface NewestMeta {
  revision: number
  author: string | null
}

function newestMeta(db: ClawbooDb | BoardTx, pageId: string): NewestMeta | undefined {
  return db
    .select({ revision: teamPageRevisions.revision, author: teamPageRevisions.author })
    .from(teamPageRevisions)
    .where(eq(teamPageRevisions.pageId, pageId))
    .orderBy(desc(teamPageRevisions.revision))
    .limit(1)
    .get()
}

function newestRevision(db: ClawbooDb | BoardTx, pageId: string): DbTeamPageRevision | undefined {
  return db
    .select()
    .from(teamPageRevisions)
    .where(eq(teamPageRevisions.pageId, pageId))
    .orderBy(desc(teamPageRevisions.revision))
    .limit(1)
    .get()
}

function toPageRecord(row: DbTeamPage, newest: NewestMeta | undefined): TeamPageRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    goalId: row.goalId ?? null,
    title: row.title,
    pinned: row.pinned === 1,
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: newest?.revision ?? 0,
    updatedBy: parseActor(newest?.author),
  }
}

function withBody(row: DbTeamPage, newest: DbTeamPageRevision | undefined): TeamPageWithBodyRecord {
  return { ...toPageRecord(row, newest), body: newest?.body ?? '' }
}

function pageRowTx(
  db: ClawbooDb | BoardTx,
  teamId: string,
  pageId: string,
): DbTeamPage | undefined {
  return db
    .select()
    .from(teamPages)
    .where(and(eq(teamPages.id, pageId), eq(teamPages.teamId, teamId)))
    .get()
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function listTeamPages(
  db: ClawbooDb,
  teamId: string,
  opts: { includeArchived?: boolean; goalId?: string; pinnedOnly?: boolean } = {},
): TeamPageRecord[] {
  const conds = [eq(teamPages.teamId, teamId)]
  if (!opts.includeArchived) conds.push(isNull(teamPages.archivedAt))
  if (opts.goalId) conds.push(eq(teamPages.goalId, opts.goalId))
  if (opts.pinnedOnly) conds.push(eq(teamPages.pinned, 1))
  return db
    .select()
    .from(teamPages)
    .where(and(...conds))
    .orderBy(desc(teamPages.updatedAt))
    .all()
    .map((row) => toPageRecord(row, newestMeta(db, row.id)))
}

/** Whether this team has this page, without reading its words. */
export function teamPageExists(db: ClawbooDb, teamId: string, pageId: string): boolean {
  return pageRowTx(db, teamId, pageId) !== undefined
}

export function getTeamPage(
  db: ClawbooDb,
  teamId: string,
  pageId: string,
): TeamPageWithBodyRecord | null {
  const row = pageRowTx(db, teamId, pageId)
  return row ? withBody(row, newestRevision(db, row.id)) : null
}

/**
 * Revisions newest first, without their words: up to `limit` older than `before`.
 * `nextBefore` is the `before` for the next page, or null when there is none.
 */
export function listPageRevisions(
  db: ClawbooDb,
  pageId: string,
  opts: { before?: number; limit?: number } = {},
): { revisions: TeamPageRevisionMetaRecord[]; nextBefore: number | null } {
  const limit = Math.max(
    1,
    Math.min(Math.floor(opts.limit ?? PAGE_REVISIONS_LIST_DEFAULT), PAGE_REVISIONS_LIST_MAX),
  )
  const where =
    opts.before !== undefined
      ? and(eq(teamPageRevisions.pageId, pageId), lt(teamPageRevisions.revision, opts.before))
      : eq(teamPageRevisions.pageId, pageId)
  const rows = db
    .select({
      id: teamPageRevisions.id,
      pageId: teamPageRevisions.pageId,
      revision: teamPageRevisions.revision,
      title: teamPageRevisions.title,
      bodyChars: sql<number>`length(${teamPageRevisions.body})`,
      author: teamPageRevisions.author,
      executionId: teamPageRevisions.executionId,
      revertedFrom: teamPageRevisions.revertedFrom,
      createdAt: teamPageRevisions.createdAt,
    })
    .from(teamPageRevisions)
    .where(where)
    .orderBy(desc(teamPageRevisions.revision))
    .limit(limit + 1)
    .all()
  const page = rows.slice(0, limit)
  return {
    revisions: page.map((r) => ({
      ...r,
      bodyChars: Number(r.bodyChars),
      author: parseActor(r.author),
      executionId: r.executionId ?? null,
      revertedFrom: r.revertedFrom ?? null,
    })),
    nextBefore: rows.length > limit ? page[page.length - 1]!.revision : null,
  }
}

/** One revision with its words, or null. */
export function getPageRevision(
  db: ClawbooDb,
  pageId: string,
  revision: number,
): TeamPageRevisionRecord | null {
  const row = db
    .select()
    .from(teamPageRevisions)
    .where(and(eq(teamPageRevisions.pageId, pageId), eq(teamPageRevisions.revision, revision)))
    .get()
  return row ? toRevisionRecord(row) : null
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface PageAuthor {
  actor: HomeActor | null
  executionId?: string | null
}

const byAgent = (author: PageAuthor): string | null =>
  author.actor?.kind === 'agent' ? author.actor.id : null

function checkBody(body: unknown, author: PageAuthor): HomeResult<string> {
  if (body !== undefined && typeof body !== 'string') return refuse('invalid')
  const text = typeof body === 'string' ? body : ''
  const max = byAgent(author) ? AGENT_PAGE_BODY_MAX_CHARS : PAGE_BODY_MAX_CHARS
  if (text.length > max) return refuse('too_long')
  return done(text)
}

/** Revisions this agent added to this page in the last hour. */
function agentRevisionsLastHour(tx: BoardTx, pageId: string, agentId: string, now: number): number {
  return tx
    .select({ author: teamPageRevisions.author })
    .from(teamPageRevisions)
    .where(
      and(
        eq(teamPageRevisions.pageId, pageId),
        gte(teamPageRevisions.createdAt, now - 60 * 60 * 1000),
      ),
    )
    .all()
    .filter((r) => {
      const a = parseActor(r.author)
      return a?.kind === 'agent' && a.id === agentId
    }).length
}

/**
 * May this author add a revision after `previous`? A person always may. An agent may
 * not past the page's agent cap, nor more than its hourly share on one page.
 */
function revisionAllowedTx(
  tx: BoardTx,
  pageId: string,
  author: PageAuthor,
  previous: { revision: number } | undefined,
  now: number,
): boolean {
  const agentId = byAgent(author)
  if (!agentId) return true
  if ((previous?.revision ?? 0) >= AGENT_PAGE_REVISION_CAP) return false
  return agentRevisionsLastHour(tx, pageId, agentId, now) < AGENT_PAGE_REVISIONS_PER_HOUR
}

/** May this agent start a page on this team? Never limits a person. */
function newPageAllowedTx(tx: BoardTx, teamId: string, author: PageAuthor, now: number): boolean {
  const agentId = byAgent(author)
  if (!agentId) return true
  const live = tx
    .select({ id: teamPages.id })
    .from(teamPages)
    .where(and(eq(teamPages.teamId, teamId), isNull(teamPages.archivedAt)))
    .all().length
  if (live >= MAX_PAGES_PER_TEAM) return false
  const started = tx
    .select({ author: teamPageRevisions.author })
    .from(teamPageRevisions)
    .innerJoin(teamPages, eq(teamPages.id, teamPageRevisions.pageId))
    .where(
      and(
        eq(teamPages.teamId, teamId),
        eq(teamPageRevisions.revision, 1),
        gte(teamPageRevisions.createdAt, now - DAY_MS),
      ),
    )
    .all()
    .filter((r) => {
      const a = parseActor(r.author)
      return a?.kind === 'agent' && a.id === agentId
    }).length
  return started < AGENT_PAGES_PER_DAY
}

function goalOkTx(tx: BoardTx, teamId: string, goalId: string | null | undefined): boolean {
  if (!goalId) return true
  const goal = tx
    .select({ teamId: teamGoals.teamId })
    .from(teamGoals)
    .where(eq(teamGoals.id, goalId))
    .get()
  return goal?.teamId === teamId
}

function emitRevised(db: ClawbooDb, page: TeamPageRecord, rev: TeamPageRevisionRecord): void {
  try {
    appendEvent(db, {
      kind: 'page_revised',
      teamId: page.teamId,
      agentId: rev.author?.kind === 'agent' ? rev.author.id : null,
      data: {
        pageId: page.id,
        revision: rev.revision,
        revertedFrom: rev.revertedFrom,
        executionId: rev.executionId,
        actor: rev.author,
      },
    })
  } catch {
    // Best effort: the revision is stored.
  }
}

function insertRevisionTx(
  tx: BoardTx,
  page: DbTeamPage,
  title: string,
  body: string,
  author: PageAuthor,
  previous: DbTeamPageRevision | undefined,
  revertedFrom: number | null,
  now: number,
): DbTeamPageRevision {
  const row: DbTeamPageRevision = {
    id: randomUUID(),
    pageId: page.id,
    revision: (previous?.revision ?? 0) + 1,
    title,
    body,
    author: actorJson(author.actor),
    executionId: author.executionId ?? null,
    revertedFrom,
    createdAt: now,
  }
  tx.insert(teamPageRevisions).values(row).run()
  return row
}

export interface CreatePageFields {
  title: string
  body?: string
  goalId?: string | null
  pinned?: boolean
}

export function createTeamPage(
  db: ClawbooDb,
  teamId: string,
  input: CreatePageFields,
  author: PageAuthor,
): HomeResult<TeamPageWithBodyRecord> {
  const title = cleanTitle(input.title)
  if (!title.ok) return refuse(title.reason)
  const body = checkBody(input.body, author)
  if (!body.ok) return body
  const result = immediateWrite(
    db,
    (tx): HomeResult<{ page: TeamPageWithBodyRecord; rev: TeamPageRevisionRecord }> => {
      if (!teamExistsForHome(tx, teamId)) return refuse('team_not_found')
      if (!goalOkTx(tx, teamId, input.goalId)) return refuse('goal_other_team')
      const now = Date.now()
      if (!newPageAllowedTx(tx, teamId, author, now)) return refuse('too_many')
      const page: DbTeamPage = {
        id: randomUUID(),
        teamId,
        goalId: input.goalId ?? null,
        title: title.title,
        pinned: input.pinned ? 1 : 0,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      tx.insert(teamPages).values(page).run()
      const rev = insertRevisionTx(tx, page, title.title, body.value, author, undefined, null, now)
      return done({ page: withBody(page, rev), rev: toRevisionRecord(rev) })
    },
  )
  if (!result.ok) return result
  emitRevised(db, result.value.page, result.value.rev)
  return done(result.value.page)
}

export interface UpdatePageFields {
  title?: string
  body?: string
  goalId?: string | null
}

/**
 * A new revision when the title or body changed; a goal change alone makes none.
 * The same words again make nothing, so a retried tool call adds no revision.
 */
export function updateTeamPage(
  db: ClawbooDb,
  teamId: string,
  pageId: string,
  input: UpdatePageFields,
  author: PageAuthor,
): HomeResult<TeamPageWithBodyRecord> {
  let title: string | undefined
  if (input.title !== undefined) {
    const t = cleanTitle(input.title)
    if (!t.ok) return refuse(t.reason)
    title = t.title
  }
  if (input.body !== undefined) {
    const b = checkBody(input.body, author)
    if (!b.ok) return b
  }
  const result = immediateWrite(
    db,
    (tx): HomeResult<{ page: TeamPageWithBodyRecord; rev: TeamPageRevisionRecord | null }> => {
      const page = pageRowTx(tx, teamId, pageId)
      if (!page) return refuse('page_not_found')
      if (page.archivedAt !== null) return refuse('archived')
      if (input.goalId !== undefined && !goalOkTx(tx, teamId, input.goalId))
        return refuse('goal_other_team')
      const previous = newestRevision(tx, pageId)
      const nextTitle = title ?? previous?.title ?? page.title
      const nextBody = input.body ?? previous?.body ?? ''
      const changed =
        nextTitle !== (previous?.title ?? page.title) || nextBody !== (previous?.body ?? '')
      const now = Date.now()
      let rev: DbTeamPageRevision | undefined = previous
      let made: TeamPageRevisionRecord | null = null
      if (changed) {
        if (!revisionAllowedTx(tx, pageId, author, previous, now)) return refuse('too_many')
        rev = insertRevisionTx(tx, page, nextTitle, nextBody, author, previous, null, now)
        made = toRevisionRecord(rev)
      }
      const patch: Partial<DbTeamPage> = {}
      if (changed) Object.assign(patch, { title: nextTitle, updatedAt: now })
      if (input.goalId !== undefined && input.goalId !== page.goalId)
        Object.assign(patch, { goalId: input.goalId, updatedAt: now })
      if (Object.keys(patch).length > 0)
        tx.update(teamPages).set(patch).where(eq(teamPages.id, pageId)).run()
      return done({ page: withBody({ ...page, ...patch }, rev), rev: made })
    },
  )
  if (!result.ok) return result
  if (result.value.rev) emitRevised(db, result.value.page, result.value.rev)
  return done(result.value.page)
}

/** A new revision that copies `revision`. */
export function revertTeamPage(
  db: ClawbooDb,
  teamId: string,
  pageId: string,
  revision: number,
  author: PageAuthor,
): HomeResult<TeamPageWithBodyRecord> {
  const result = immediateWrite(
    db,
    (tx): HomeResult<{ page: TeamPageWithBodyRecord; rev: TeamPageRevisionRecord }> => {
      const page = pageRowTx(tx, teamId, pageId)
      if (!page) return refuse('page_not_found')
      if (page.archivedAt !== null) return refuse('archived')
      const old = tx
        .select()
        .from(teamPageRevisions)
        .where(and(eq(teamPageRevisions.pageId, pageId), eq(teamPageRevisions.revision, revision)))
        .get()
      if (!old) return refuse('revision_not_found')
      const previous = newestRevision(tx, pageId)
      const now = Date.now()
      if (!revisionAllowedTx(tx, pageId, author, previous, now)) return refuse('too_many')
      const rev = insertRevisionTx(
        tx,
        page,
        old.title,
        old.body,
        author,
        previous,
        old.revision,
        now,
      )
      tx.update(teamPages)
        .set({ title: old.title, updatedAt: now })
        .where(eq(teamPages.id, pageId))
        .run()
      return done({
        page: withBody({ ...page, title: old.title, updatedAt: now }, rev),
        rev: toRevisionRecord(rev),
      })
    },
  )
  if (!result.ok) return result
  emitRevised(db, result.value.page, result.value.rev)
  return done(result.value.page)
}

export function setTeamPagePinned(
  db: ClawbooDb,
  teamId: string,
  pageId: string,
  pinned: boolean,
): HomeResult<TeamPageRecord> {
  return immediateWrite(db, (tx): HomeResult<TeamPageRecord> => {
    const page = pageRowTx(tx, teamId, pageId)
    if (!page) return refuse('page_not_found')
    const value = pinned ? 1 : 0
    if (page.pinned !== value)
      tx.update(teamPages).set({ pinned: value }).where(eq(teamPages.id, pageId)).run()
    return done(toPageRecord({ ...page, pinned: value }, newestMeta(tx, pageId)))
  })
}

export function archiveTeamPage(
  db: ClawbooDb,
  teamId: string,
  pageId: string,
): HomeResult<TeamPageRecord> {
  return immediateWrite(db, (tx): HomeResult<TeamPageRecord> => {
    const page = pageRowTx(tx, teamId, pageId)
    if (!page) return refuse('page_not_found')
    if (page.archivedAt !== null) return done(toPageRecord(page, newestMeta(tx, pageId)))
    const now = Date.now()
    tx.update(teamPages).set({ archivedAt: now, pinned: 0 }).where(eq(teamPages.id, pageId)).run()
    return done(toPageRecord({ ...page, archivedAt: now, pinned: 0 }, newestMeta(tx, pageId)))
  })
}

/** An agent's page write: a new page by title, or a new revision of one by id. */
export function agentWritePage(
  db: ClawbooDb,
  input: {
    teamId: string
    pageId?: string | null
    title?: string | null
    body: string
    goalId?: string | null
    agent: HomeActor
    executionId?: string | null
  },
): HomeResult<TeamPageWithBodyRecord> {
  const author = { actor: input.agent, executionId: input.executionId ?? null }
  if (input.pageId) {
    return updateTeamPage(
      db,
      input.teamId,
      input.pageId,
      {
        body: input.body,
        ...(input.title ? { title: input.title } : {}),
        ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
      },
      author,
    )
  }
  if (!input.title) return refuse('empty')
  return createTeamPage(
    db,
    input.teamId,
    { title: input.title, body: input.body, goalId: input.goalId ?? null },
    author,
  )
}
