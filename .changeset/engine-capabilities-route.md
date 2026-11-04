---
'clawboo': minor
---

Clients can ask the server which version and features it has.

**`GET /api/system/capabilities`** answers with the running version, a client API revision, the oldest release whose clients the server still serves, and a flag for each optional feature: the runtimes it can run, chat rooms, 1:1 chats, the check on finished work, comments that reach a running task, the workspace view and preview, routines, memory and similarity search, connectors, and which event streams resume from `Last-Event-ID`. It reads nothing from disk beyond the version, writes nothing, and sits behind the origin check and access token like every other `/api` route.

**A server supports clients of its current and previous minor release.** Nothing a client in that window uses is removed or renamed; when something has to go, it goes in a minor release and the API revision goes up. The new Supported versions page explains the window, how a client checks it, and what the npm install, the desktop app and the phone web app each offer.

**The in-app update confirms the new version before it reloads.** After an update the dashboard used to reload once any server answered the settings route. It now reads the new route and reloads once a server on a different version answers.

**A contract test pins what clients rely on**: the capabilities answer, every API route and method, and the events and fields of the team chat, 1:1 chat and event streams. Removing or renaming any of them fails the test unless the API revision goes up.
