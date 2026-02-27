// Type shim for the pre-bundled ELK build.
// The main 'elkjs' types live at elkjs/elk.d.ts; this re-exports them for the
// bundled path so TypeScript resolves correctly without needing a WebWorker.
declare module 'elkjs/lib/elk.bundled.js' {
  import ELK from 'elkjs'
  export default ELK
}
