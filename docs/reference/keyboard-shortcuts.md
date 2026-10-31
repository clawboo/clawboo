---
title: 'Keyboard shortcuts'
description: 'Every keyboard shortcut in the Clawboo dashboard, by surface, plus the chat slash commands and how Settings search finds a panel.'
keywords:
  [
    'hotkeys',
    'keyboard',
    'Cmd+1',
    'Ctrl+1',
    'Cmd+K',
    'slash commands',
    '/reset',
    '/rule',
    'settings search',
  ]
---

Every shortcut the dashboard handles, grouped by where it works. On macOS use `Cmd`; on Windows and Linux use `Ctrl`. The tables write `Cmd/Ctrl` for both.

| Surface                                               | Shortcuts                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Anywhere](#anywhere)                                 | Jump to a view, open Settings, show or hide the sidebar, Escape                   |
| [Chat](#chat)                                         | Send, new line, mentions, steering a task, room names                             |
| [Slash commands](#slash-commands)                     | `/reset`, `/new`, `/rule`                                                         |
| [Board](#board)                                       | New task, views, today, previous and next, Find, the task drawer, the date picker |
| [Org chart and team graph](#org-chart-and-team-graph) | Expand a Boo, its menu, remove a connection, the add picker                       |
| [Settings](#settings)                                 | Search, close                                                                     |
| [Editors and dialogs](#editors-and-dialogs)           | Save, confirm, cancel, onboarding                                                 |

## Anywhere

| Shortcut     | What it does                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cmd/Ctrl+1` | Open the Org chart                                                                                                                                                           |
| `Cmd/Ctrl+2` | Open the Board                                                                                                                                                               |
| `Cmd/Ctrl+3` | Open Connectors                                                                                                                                                              |
| `Cmd/Ctrl+4` | Open Memory                                                                                                                                                                  |
| `Cmd/Ctrl+,` | Open Settings                                                                                                                                                                |
| `Cmd/Ctrl+\` | Show or hide the sidebar                                                                                                                                                     |
| `Escape`     | Close the topmost menu, popover or dialog. With none open, close Settings; with Settings closed, leave an agent, Boo Zero or team chat for the **Welcome to Clawboo** screen |

`Cmd/Ctrl+1` to `4`, `Cmd/Ctrl+,` and the view-leaving `Escape` do nothing while you type in a text field or while a dialog has the keyboard. `Cmd/Ctrl+\` works everywhere, even while you type.

The sidebar's resize handle (**Resize sidebar**) takes the keyboard too: focus it, then use the left and right arrow keys to make the sidebar narrower or wider. Left at the narrowest width, or `Enter`, collapses it. Double-click the handle to reset its width.

## Chat

These work in 1:1 chats, team chat and rooms.

| Shortcut         | What it does                                                            |
| ---------------- | ----------------------------------------------------------------------- |
| `Enter`          | Send the message                                                        |
| `Shift+Enter`    | Start a new line                                                        |
| `@`              | Open the mention list: teammates in team chat, teams in Boo Zero's chat |
| `Up` / `Down`    | Move through the mention list while it is open                          |
| `Enter` or `Tab` | Insert the highlighted mention                                          |
| `Escape`         | Close the mention list                                                  |

In a team's **Tasks** card, the **Comment or steer this task** box sends with `Enter` (`Shift+Enter` for a new line), and `Escape` inside an open task returns to the task list. When you rename a room, `Enter` saves the name and `Escape` cancels. In **Search agents**, `Escape` clears the search and closes it.

## Slash commands

Type these as the whole message.

| Command            | Where     | What it does                                                                                                             |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/reset` or `/new` | Any chat  | The agent stops carrying the conversation so far. Your messages stay, and a divider marks the point. Not case-sensitive. |
| `/rule <text>`     | Team chat | Adds `<text>` to the team's rules. It needs a space and some text after `/rule`.                                         |

[Team chat](/using/team-chat) covers starting fresh and clearing a chat; [Teams](/using/teams) covers team rules.

## Board

These work while the board has focus, and not while you type, drag a card, or have a task, the new-task form, a Routine dialog or Settings open.

| Shortcut         | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `C`              | Open **New task**                                          |
| `K`              | Switch to **Kanban** (`A` also works)                      |
| `D`              | Switch to **Today**                                        |
| `W`              | Switch to **Week**                                         |
| `M`              | Switch to **Month**                                        |
| `T`              | Go to today (in **Today**, **Week** and **Month**)         |
| `Left` / `Right` | Previous or next week or month (in **Week** and **Month**) |
| `/`              | Open **Find**                                              |
| `Escape`         | Clear a picked date                                        |

While focus is inside the calendar grid, the left and right arrow keys scroll it instead.

`Cmd/Ctrl+K` also opens **Find**, from anywhere on the Board page and even while you type in a field. It does nothing while a dialog, a menu or the task drawer is open.

In the task drawer, `J` opens the next task in the card's column and `K` the previous one, the same as the up and down arrow buttons at the top of the drawer. They do nothing while focus is in a field or an open list. `Escape` closes the drawer.

In **Find**, focus stays in the search field: `Up` and `Down` move through the results, `Enter` shows the highlighted task on the board, and `Shift+Enter` opens it. A Routine always opens.

In the date picker (click the date range title, **Choose a date**), the arrow keys move a day or a week, `Page Up` and `Page Down` move a month, `Home` and `End` go to the start and end of the week, and `Enter` picks the day. When you mark a task done or cancel it, `Enter` confirms the dialog and the arrow keys move between the day choices.

## Org chart and team graph

The same keys work on the Org chart and on a team's graph card. Use `Tab` to focus a Boo first.

| Shortcut                                           | What it does                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Enter` or `Space` on a Boo                        | Expand or collapse the tiles around it                                       |
| `Menu` key, `Shift+F10` or `Alt+Enter` on a Boo    | Open its menu (**Open agent**, **Delete**). On a Mac, `Option+Enter`.        |
| Arrow keys on a selected Boo                       | Move it, unless the canvas is locked                                         |
| `Backspace` or `Delete` with a connection selected | Remove that connection: a routing link, an added skill or a shared connector |

A connection that came with the agent or its runtime cannot be removed; the graph says why instead. When you drag a thread from a Boo to empty space, the picker that opens takes `Up` and `Down` to move, `Enter` to pick, `Right` to open a category, `Left` or `Backspace` (in an empty search) to go back, and `Tab` to close.

## Settings

When **Settings** opens, the **Search settings** field has focus. Type to narrow the list to panels whose name or keywords contain what you typed. For example, `cron` finds Routines, `api key` finds Providers and System, `budget` finds Tokens Used and Governance, and `traces` finds Observability.

| Shortcut            | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `Cmd/Ctrl+,`        | Open Settings                                   |
| `Tab` / `Shift+Tab` | Move between controls; focus stays in Settings  |
| `Escape`            | Close Settings (an open picker inside it first) |

## Editors and dialogs

| Where                                                             | Shortcut     | What it does                                                           |
| ----------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------- |
| An agent file editor (**Agent Files**, or the full-screen editor) | `Cmd/Ctrl+S` | Save the file                                                          |
| The full-screen agent file editor                                 | `Escape`     | Save any unsaved files and close                                       |
| **Personality**, with **Use Custom Instructions** on              | `Cmd/Ctrl+S` | Save the custom instructions (they also save when you leave the field) |
| A confirmation dialog                                             | `Enter`      | Confirm                                                                |
| A confirmation dialog                                             | `Escape`     | Cancel                                                                 |
| Onboarding                                                        | `Escape`     | Go back one step (onboarding cannot be dismissed)                      |
| A field for an API key or Gateway address                         | `Enter`      | Save or connect, the same as the button next to it                     |

The file editors also take the usual undo and redo keys.

<Accordion title="Under the hood">

Source of truth: `apps/web/src/features/layout/ContentArea.tsx` (view shortcuts and `Escape`), `features/layout/AppSidebar.tsx` (sidebar), `features/chat/chatComponents.tsx` (composer), `features/chat/resetConversation.ts` and `lib/teamRules.ts` (slash commands), `features/board/BoardPanel.tsx`, `features/board/TaskDetailDrawer.tsx` and `features/board/calendar/` (board), `features/graph/graphKeyAction.ts` and `features/graph/ThreadPicker.tsx` (graph), `features/settings/SettingsModal.tsx` (Settings search and its keywords), `features/shared/useDismissableLayer.ts` (one `Escape` closes one layer).

</Accordion>

## Related

- [Dashboard tour](/getting-started/dashboard-tour): where each view lives
- [Board](/using/board): views, the toolbar, Find and the task drawer
- [Org chart](/using/org-chart): what the tiles and connections mean
- [Team chat](/using/team-chat): rooms, mentions, `/reset` and Clear chat
