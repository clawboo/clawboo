---
'clawboo': patch
---

Remove `POST /api/onboarding/seed-native-team`, the endpoint that created a two-agent "My First Team" (a Team Lead and a Coder).

Onboarding stopped using it when the wizard started sending new users to the marketplace, where they pick a team and deploy it, so nothing in Clawboo called it. It stayed documented as a quick way to stand up a default team, which let a placeholder team appear that no user had chosen. The endpoint, its `seedNativeTeam` wrapper in `@clawboo/control-client`, and its docs are gone. Deploy a team from the marketplace, or through `POST /api/teams`, instead. The onboarding endpoints that record the native leader model are unchanged.
