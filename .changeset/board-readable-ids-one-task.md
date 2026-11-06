---
'clawboo': minor
---

Tasks now have readable ids and are made once.

- **Readable ids.** A team's tasks read like `MAR-12`: letters from the team's name, unique across your Clawboo (a clash takes the next free set, like `MA2`), and a number. They show on cards, in the drawer and on task cards in chat, and the Tasks tools and Find take them. A person can change the letters in Team settings until the team's first task; a team rename never changes an id. Existing tasks get theirs the first time the server starts. A task with no team has none.
- **One task per create.** The New task dialog, the Tasks tools and team-chat hand-offs send an idempotency key, kept in the database, so a retry returns the same task with `deduplicated: true`. An agent creating or handing off an open task with the same words under the same parent within 48 hours gets that task back, and is told. Blocked work, stopped work and a person's own creates are left out, and one turn asking two teammates the same thing makes a task for each.
- **No circles.** An agent cannot hand work back to an agent waiting on it, on any path. The team's lead is exempt, because every agent is told to take a blocker there.
- **Caps that hold.** The 8 hand-off cap counts a whole turn, not each tool call. Team-chat hand-offs now answer to the 24-child and 30-per-5-minutes caps, and a plan can have at most 25 steps. The failure breaker survives a restart. Only a person's cancel frees a child's place.
- **Urgent is a person's call.** An agent stops at High through `create_task`, and so does a REST caller that is not the dashboard, on the board's routes and on a routine's task template.
- **Labels.** Teams have labels, set in the task drawer, managed in Team settings, and filterable on the board.

New routes: `GET`/`PUT /api/teams/:id/task-prefix`, `GET`/`POST /api/teams/:id/labels`, `PATCH`/`DELETE /api/teams/:id/labels/:labelId`, `PUT /api/board/:taskId/labels`. New capability flags: `board.readableIds`, `board.labels`. The `board` chat stream frame gains `identifier`.
