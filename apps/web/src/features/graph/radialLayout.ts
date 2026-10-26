// The org chart's radial spacing, used by its layout (useGraphLayout).
//
// The layout is final as computed. Physics only relaxes it, and under reduced
// motion a Boo lands where the layout puts it, so the spacing here is the
// spacing on screen: no two Boos closer than ATLAS_RADIAL_BOO_SPACING.

export interface RadialPoint {
  x: number
  y: number
}

/** Distance from Boo Zero's centre to a team's junction, unless the teams need more room. */
export const ATLAS_RADIAL_TEAM_RADIUS = 600
/** Distance from a team's junction to each member's centre, unless its fan needs more room. */
export const ATLAS_RADIAL_MEMBER_RADIUS = 320
/**
 * The least distance between two Boos' centres. A Boo is drawn with its name
 * and status rows below it and, while it works, a thought bubble off its
 * upper-right shoulder. Measured in the app, a one-line bubble needs 262 to
 * clear a neighbour in the worst direction (one below and to its left) and a
 * Boo without one needs 203.
 */
export const ATLAS_RADIAL_BOO_SPACING = 270
/** A team's fan never opens wider than 150°. Wider, its ends curl back toward Boo Zero. */
export const ATLAS_RADIAL_MAX_FAN_ARC = (Math.PI * 150) / 180
/** How far the team ring steps out while neighbouring fans are too close. */
const TEAM_RADIUS_STEP = 20

export interface RadialFan {
  /** Distance from the junction to each member's centre. */
  radius: number
  /** The angle between the first and last member, seen from the junction. */
  arc: number
}

/**
 * A team's fan of `numMembers`: neighbours ATLAS_RADIAL_BOO_SPACING apart at
 * the default radius, and once that would open the fan past
 * ATLAS_RADIAL_MAX_FAN_ARC, the widest fan pushed out until they are.
 */
export function radialFan(numMembers: number): RadialFan {
  if (numMembers <= 1) return { radius: ATLAS_RADIAL_MEMBER_RADIUS, arc: 0 }
  const gaps = numMembers - 1
  const step = 2 * Math.asin(Math.min(1, ATLAS_RADIAL_BOO_SPACING / 2 / ATLAS_RADIAL_MEMBER_RADIUS))
  if (step * gaps <= ATLAS_RADIAL_MAX_FAN_ARC) {
    return { radius: ATLAS_RADIAL_MEMBER_RADIUS, arc: step * gaps }
  }
  const arc = ATLAS_RADIAL_MAX_FAN_ARC
  return { radius: ATLAS_RADIAL_BOO_SPACING / 2 / Math.sin(arc / gaps / 2), arc }
}

export interface RadialTeamPlacement {
  /** The team's junction, Boo Zero's centre being (0, 0). */
  junction: RadialPoint
  /** Each member's centre, in the order given. */
  members: RadialPoint[]
}

function placeTeams(teamSizes: readonly number[], teamRadius: number): RadialTeamPlacement[] {
  return teamSizes.map((size, i) => {
    // From 12 o'clock, clockwise, an equal turn of the circle each.
    const theta = -Math.PI / 2 + (2 * Math.PI * i) / teamSizes.length
    const junction = { x: teamRadius * Math.cos(theta), y: teamRadius * Math.sin(theta) }
    const fan = radialFan(size)
    const members: RadialPoint[] = []
    for (let j = 0; j < size; j++) {
      // The fan opens away from Boo Zero, centred on the team's direction.
      const angle = size === 1 ? theta : theta - fan.arc / 2 + (fan.arc * j) / (size - 1)
      members.push({
        x: junction.x + fan.radius * Math.cos(angle),
        y: junction.y + fan.radius * Math.sin(angle),
      })
    }
    return { junction, members }
  })
}

/** Whether every Boo from different teams, and every Boo and Boo Zero, keep the spacing. */
function teamsClear(teams: readonly RadialTeamPlacement[]): boolean {
  const min = ATLAS_RADIAL_BOO_SPACING * ATLAS_RADIAL_BOO_SPACING
  for (let a = 0; a < teams.length; a++) {
    for (const p of teams[a]!.members) {
      if (p.x * p.x + p.y * p.y < min) return false
      for (let b = a + 1; b < teams.length; b++) {
        for (const q of teams[b]!.members) {
          const dx = p.x - q.x
          const dy = p.y - q.y
          if (dx * dx + dy * dy < min) return false
        }
      }
    }
  }
  return true
}

/**
 * Where each team's junction and members sit around Boo Zero, for teams of
 * `teamSizes` members. Members of one team keep the spacing by their fan; the
 * team ring starts at ATLAS_RADIAL_TEAM_RADIUS and steps out until members of
 * different teams keep it too.
 */
export function radialTeamPlacements(teamSizes: readonly number[]): RadialTeamPlacement[] {
  let radius = ATLAS_RADIAL_TEAM_RADIUS
  let teams = placeTeams(teamSizes, radius)
  // Bounded so a pathological input cannot hang the layout: 500 steps is a
  // ring of 10,600, far past any fleet a canvas can show.
  for (let i = 0; i < 500 && !teamsClear(teams); i++) {
    radius += TEAM_RADIUS_STEP
    teams = placeTeams(teamSizes, radius)
  }
  return teams
}
