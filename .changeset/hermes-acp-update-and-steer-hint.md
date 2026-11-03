---
'clawboo': patch
---

A Hermes installed without its live mode now says so, offers a one-click update, and its running tasks say how a comment will reach them.

**Update Hermes.** Clawboo asks Hermes with `hermes acp --check`, in a throwaway home it removes afterwards, whenever the runtimes list is read (at most once every ten minutes, never waiting for the answer). A Hermes without ACP reads **Update available** in **Settings** > **Runtimes**, and its row offers **Update Hermes** beside its keys and sign-in. The update reinstalls `hermes-agent[anthropic,acp]<1` in place (`pipx install --force`, or `pip install --upgrade --user`), then asks Hermes again before it reports done, so the next run uses ACP. A Hermes without ACP also stays on its quiet path from that answer alone, so no run pays for a failed ACP start first. The runtimes list reports the answer as `acpMissing`, and its Hermes `steering` and `streaming` follow it.

**An exact hint on running tasks.** The line beside **Send** on a running task now follows the run on it: a Hermes run on its quiet path reads "… pauses to read this, then carries on.", including a run that fell back from ACP while new runs would be live, and the other way round. With no run to ask, it follows what the agent's runtime takes now. `GET /api/board/:taskId` reports the run's way as `runSteering`, and an adapter can report it per run with the new optional `runSteering(run)`.
