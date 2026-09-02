// ─── @clawboo/pack-format ───────────────────────────────────────────────────
// The versioned marketplace pack schema: the v1 shapes, the version ladder, and
// the one parser every reader shares (the emitter, the repo gate, the browser).
//
// PRIVATE, AND IT STAYS PRIVATE. The published artifact is the SPECIFICATION,
// not the package: `catalog/schema/{pack,index}.schema.json` (JSON Schema
// 2020-12) is what a third party writes against, and this package is the
// TypeScript mirror the repo itself uses. Nobody outside the repo needs an npm
// install to author a pack.
//
// EVERY RE-EXPORT IS BY NAME. `export * from '<workspace dep>'` does not work
// here: tsup keeps workspace deps external, and a downstream esbuild cannot
// resolve a star re-export through the external boundary. Local modules are
// listed by name too, so the barrel doubles as the public surface.

export type {
  Adaptation,
  AgentBody,
  AgentListing,
  AgentPack,
  CategoryId,
  EntryOrigin,
  Open,
  PackManifest,
  PackSkill,
  Provenance,
  SkillCategory,
  SourceId,
  SpdxId,
  TeamBody,
  TeamListing,
  TeamMemberRef,
} from './types'

export {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  PACK_FORMAT_VERSION,
  SUPPORTED_RANGE,
} from './version'

export {
  EXACT_SEMVER,
  HEX_COLOR,
  KEBAB,
  adaptationV1,
  agentBodyV1,
  agentListingV1,
  agentPackV1,
  agentPackV1Strict,
  entryOriginV1,
  packSkillV1,
  provenanceV1,
  skillCategoryV1,
  teamBodyV1,
  teamListingV1,
  teamMemberRefV1,
} from './schema'

export { KNOWN_SCHEMA_VERSIONS, SCHEMAS, STRICT_SCHEMAS, UPGRADES } from './registry'
export type { Upgrade } from './registry'

export { DEFAULT_LADDER, STRICT_LADDER, parseAgentPack, runUpgrades } from './parse'
export type {
  Ladder,
  PackIssue,
  PackParseFailure,
  PackParseResult,
  PackParseSuccess,
  PackRejectCode,
  ParseAgentPackOptions,
  StaleVersionPolicy,
} from './parse'
