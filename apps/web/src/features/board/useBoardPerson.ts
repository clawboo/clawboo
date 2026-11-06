// Who "you" is on the board: the person a sign-in proxy vouched for, else the
// install's built-in person. Read once per page load and kept: it cannot change
// without a reload, and every card that says "you" reads it.

import { useEffect, useState } from 'react'

import { LOCAL_PERSON } from '@clawboo/board-core'

import { fetchBoardPerson } from '@/lib/boardClient'

export interface BoardPerson {
  id: string
  name: string | null
  role: string | null
}

let known: BoardPerson | null = null
let reading: Promise<BoardPerson | null> | null = null

/** Test helper: forget who was read. */
export function resetBoardPerson(): void {
  known = null
  reading = null
}

/** `needed` false skips the read: most cards never ask who you are. */
export function useBoardPerson(needed = true): BoardPerson {
  const [person, setPerson] = useState<BoardPerson>(known ?? { ...LOCAL_PERSON })
  useEffect(() => {
    if (!needed) return
    if (known) {
      setPerson(known)
      return
    }
    let live = true
    reading ??= fetchBoardPerson()
    void reading.then((read) => {
      // A read that failed is tried again by the next board to open.
      if (!read) reading = null
      else known = read
      if (live && read) setPerson(read)
    })
    return () => {
      live = false
    }
  }, [needed])
  return person
}
