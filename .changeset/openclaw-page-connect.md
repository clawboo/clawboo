---
'clawboo': minor
---

A dashboard page that was already open when something else connected Clawboo to the OpenClaw Gateway, such as a routine for an OpenClaw agent or OpenClaw opened in another tab, can now connect itself without a reload. OpenClaw's row in **Settings > Runtimes** reads **Connected** and offers **Connect this page** beside **Manage** while the page has no Gateway connection of its own, which OpenClaw 1:1 chats need. Clicking it twice still connects once. If the page cannot connect, a message says so and points at **Connect this page**, and the button stays so you can try again.
