---
title: Review and revoke command permissions
description: Read the standing grants an exec Always created for an OpenClaw Boo, set its command-execution posture, and revoke a permission.
---

Use this page when you want to know what an OpenClaw Boo can already run on your computer without asking you, and when you want to take one of those permissions back. Every time you answer **Always** to an [exec approval](/using/approvals), Clawboo asks the Gateway to remember that command, and this is the screen where the result becomes visible again.

It is a narrow screen on purpose. It shows one Boo's command-execution posture and the standing grants Clawboo can read for it, and the only thing it can change about a grant is to remove it.

## Prerequisites

<Note>
This is **not** a general per-agent permissions list. The **Permissions** tab appears only on **OpenClaw** and **Clawboo Native** Boos, and the standing-grants list renders for **OpenClaw only**. A native Boo gets the **Running commands** switch in that same tab instead, which is a different control over a different store.
</Note>

- An OpenClaw Boo, opened from the agent column.
- Reading the list needs nothing running but Clawboo itself. Clawboo does not ask the Gateway for it: it opens OpenClaw's own state database on this computer **read-only** and reads the stored policy. That is deliberate, because the Gateway call that would return the same data is a write, and issuing it against a document Clawboo could not parse would replace that document. Opening a permissions panel must not be able to destroy a policy.
- **Revoking** does go through the Gateway, so a revoke needs a connected Gateway even though the list you are looking at did not.

## Where it lives

Agent detail → the **Permissions** tab. Two controls are stacked there:

1. **Execution Permissions**, holding the **Command Execution** dropdown: when this Boo asks you at all.
2. **Commands this Boo can run without asking**, the standing-grants list: what it no longer asks about.

## Steps

### 1. Set the posture

**Command Execution** has three options, and the dropdown states each one in its own words:

| Option              | What the dropdown says                | What it means for you                                                                                       |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Run Freely**      | `Executes commands without asking`    | No approval card is ever raised. The Boo runs what it decides to run                                        |
| **Ask for Unknown** | `Asks approval for unlisted commands` | A command outside the list below raises an approval card. The list is what Clawboo reads as already allowed |
| **Always Ask**      | `Asks approval for every command`     | Every command raises a card, and Clawboo withholds **Always** on the card it mirrors into its own queue     |

Changing the posture here applies it at the Gateway for that Boo, not just in Clawboo's own record.

<Warning>
**Always Ask and the list below can both be true at once.** Putting a Boo on **Always Ask** stops Clawboo from offering an Always on a mirrored card, though the live card in an open tab still carries the button, and it does not clear the grants already on file. If you want an existing permission gone, revoke it (step 3).
</Warning>

### 2. Read the standing grants

The card headed **Commands this Boo can run without asking** lists what Clawboo found. Each row names the program (the resolved path when one was recorded, otherwise the stored pattern) and describes, in one line, how wide the permission is:

| What the row says                       | How wide it is                                   | Does it grant execution?                         |
| --------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| One exact command, in one exact folder  | The narrowest kind                               | Yes                                              |
| One exact command                       | That command, anywhere                           | Yes                                              |
| This program, matching arguments        | That program, when the arguments match           | Yes                                              |
| This program, any arguments, any folder | Everything that program can do                   | Yes, and the row carries a **Broad** pill        |
| Any command at all                      | Everything                                       | Yes, and the row carries a **Broad** pill        |
| Part of another grant on this computer  | Half of a pair, not a permission on its own      | No, but Clawboo treats it as load-bearing        |
| Kept on file, but OpenClaw skips it     | A row that looks like a grant and is not matched | No, and the row carries a **Not in effect** pill |

Three more things a row can tell you:

- **"and its companion rule"**: a single Always wrote more than one row, and Clawboo has grouped them so you see one permission rather than sibling entries you would have to reason about.
- On the narrowest kind of row: "clawboo cannot show which command: OpenClaw keeps only a fingerprint of it and the folder it ran in. The same command typed differently, or run elsewhere, asks again." The text of the command is not recoverable, so the row says so rather than dressing up a digest as a command.
- **"Also granted to every Boo. Removing it here would not stop it."** on a row that is also in the fleet-wide bucket. Its revoke button is disabled.

A footer appears when the fleet-wide bucket has anything in it: "N permissions apply to every Boo on this computer. Those are set outside clawboo and cannot be changed here."

An unpaired companion row shows the static text **"Not removable here"** where the revoke button would be. It is half of some grant, and which one cannot be worked out from the list, so removing it could break a grant still shown as working further up the screen.

### 3. Revoke a standing permission

Click the trash icon on the row. A confirm dialog appears, titled **"Revoke this standing permission?"**, and it tells you three things:

- "`<name>` will need your approval again the next time this Boo runs it."
- For a grouped row: "Both rules this approval created are removed together."
- Always: "A command already approved and waiting to run may fail, because OpenClaw checks the whole rule set again before it starts."

Confirm with **Revoke**. On success you get a **"Standing permission revoked"** toast; on failure you get the server's own error string, or **"Could not revoke that permission"**.

Nothing is removed from the screen optimistically. There is no revoke RPC to call, so Clawboo rewrites the whole fleet permissions document under the Gateway's compare-and-swap, proves the removal against the Gateway's own reply rather than against what it sent, and re-reads the list before showing you any result. The one thing this screen must not do is show a permission as revoked while the Gateway still honours it.

The outcomes:

| Outcome            | Status | What it means                                                                                                     |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `revoked`          | 200    | Gone, and confirmed gone against the Gateway's post-write reply                                                   |
| `already-absent`   | 409    | Those grants were already gone                                                                                    |
| `blocked-wildcard` | 409    | At least one key is also in the fleet-wide bucket, which is expected to be honoured ahead of this Boo's own entry |
| `no-such-agent`    | 409    | The Gateway has no entry for this Boo                                                                             |
| `not-verified`     | 502    | The write **landed** and could not be confirmed. This is the one outcome that is not a no-op                      |

<Warning>
**`blocked-wildcard` is all-or-nothing.** One key that is also granted fleet-wide aborts every key in the same request, including the ones that would have been removed cleanly. Nothing partial is written.
</Warning>

## The four read states

The list has four states and they are not interchangeable. Telling them apart is the point of the screen.

| State            | What you see                                                                                                     | Over the API                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Rows             | The grants, one per permission                                                                                   | 200, `state: 'ok'`              |
| Nothing granted  | **"No standing permissions"**, with "When you answer Always to a command prompt, what you allowed appears here." | 200, `state: 'ok'` with no rows |
| No policy at all | **"No standing permissions"**, with "Nothing on this computer has been granted a standing exec permission yet."  | 200, `state: 'absent'`          |
| Could not read   | A red alert, not an empty state                                                                                  | **502**, `state: 'unreadable'`  |

A fifth possibility is that the panel is not rendered at all, which is what a non-OpenClaw agent gets.

<Danger>
**An unreadable list is not an empty one.** When Clawboo cannot read the policy, it says so: "clawboo could not read this computer's permission list, which last held N rules. Nothing here is safe to trust until it can be read again." The count comes from the last successful save, and it is the whole difference between "nothing is granted" and "something is granted and Clawboo cannot see it". The grants are still on disk and still enforced. Never read that alert as a clean slate.
</Danger>

## Honest limits

- **The list does not update live.** It reads when you open the tab, when you press **Refresh**, and after a revoke attempt. A grant you mint by answering **Always** while the tab is open will not appear until you refresh.
- **Fleet-wide grants cannot be revoked here at all.** They surface only as a count in the footer, and as the disabled revoke on a row that duplicates one.
- **Pairing is all-or-nothing.** Clawboo groups a grant with its companion row only when the Boo has exactly one of each. A Boo with two remembered commands shows each companion separately as its own "Not removable here" row.
- **The screen is revoke-only.** There is no way to create a grant, edit one, or narrow one from Clawboo. A grant is created by answering **Always** to a command prompt, and that is the only way.
- The counts behind the unreadable alert are **document-wide**, covering every Boo in the file, not just this one.

## Verify it worked

- After a revoke, the row is gone from the list you are looking at, because the list was re-read before the result was shown. If the row is still there, the revoke did not take, whatever the toast said.
- Ask the Boo to run the command again. On **Ask for Unknown** or **Always Ask** it should raise an approval card instead of running.
- Press **Refresh** after answering **Always** to a command prompt and the new permission appears.

## Troubleshooting

<Warning>
**The list says it could not be read.** "Could not read" is not proof of a corrupt database. It also covers a Clawboo server that is simply down, a response Clawboo did not recognise, and any transport failure. It reads `<state dir>/state/openclaw.sqlite`, where the state directory is `OPENCLAW_STATE_DIR` if set, then `MOLTBOT_STATE_DIR`, then `CLAWDBOT_STATE_DIR`, otherwise `~/.openclaw` when that exists, otherwise the first existing legacy directory among `~/.clawdbot` and `~/.moltbot`. A state directory somewhere Clawboo is not looking produces exactly this alert.
</Warning>

<Warning>
**The revoke button is greyed out.** Either the row is also granted to every Boo on this computer (the row says so, and removing it here would not stop it), or a revoke is already in flight. Fleet-wide entries are set outside Clawboo and have to be changed there.
</Warning>

<Warning>
**A revoke came back `not-verified`.** The write reached the Gateway and Clawboo could not confirm the result. Do not assume it failed and do not assume it succeeded. Press **Refresh** and read the list again.
</Warning>

## Related

- [Approvals](/using/approvals), where an **Always** is given in the first place, and when it is offered at all
- [Agents](/using/agents), the agent detail view this tab lives in
- [OpenClaw runtime](/runtimes/openclaw), the substrate whose policy this screen reads
- [Data and state](/operating/data-and-state), the files Clawboo reads from OpenClaw's state directory
