// The org chart's radial spacing, shared by the layout (useGraphLayout) and by
// the moves made on top of it (rotateGraph: turning to a team, focusing an agent).

/** Distance from Boo Zero's centre to a team's junction. */
export const ATLAS_RADIAL_TEAM_RADIUS = 600
/** Distance from a team's junction to each member's centre. */
export const ATLAS_RADIAL_MEMBER_RADIUS = 320
/** A team's fan of members never opens wider than 60°. */
export const ATLAS_RADIAL_MAX_FAN_ARC = (Math.PI * 60) / 180
/** About 20° per member, capped by the fan above. */
export const ATLAS_RADIAL_PER_MEMBER_ARC = Math.PI / 9

/** A team's fan, for `numMembers` members when `numTeams` teams share the
 *  circle: a single member points straight out, more open up to the cap. */
export function radialFanArc(numMembers: number, numTeams: number): number {
  if (numMembers <= 1) return 0
  const anglePerTeam = (2 * Math.PI) / Math.max(1, numTeams)
  const cap = Math.min(ATLAS_RADIAL_MAX_FAN_ARC, anglePerTeam * 0.7)
  return Math.min(cap, (numMembers - 1) * ATLAS_RADIAL_PER_MEMBER_ARC)
}
