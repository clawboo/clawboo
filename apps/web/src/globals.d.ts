// The URL prefix the server templates into the SPA shell it serves. Absent when
// clawboo is served at the origin root (the default) and in `pnpm dev`, where
// Vite serves the shell untouched. Read once by `app/bootstrapBase.ts`.
declare global {
  var __CLAWBOO_BASE__: string | undefined
}

export {}
