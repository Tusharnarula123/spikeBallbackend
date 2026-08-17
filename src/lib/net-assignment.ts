/**
 * Team + net assignment for rotating competitive sessions.
 *
 * Each round players are paired into teams, then teams are matched onto nets.
 * Two goals pull against each other: teams and matchups should be ELO-similar,
 * but the same strong players shouldn't be stuck together every round. So a
 * candidate assignment is *scored* (tight ELO spread = good, repeat teammates
 * and repeat opponents = bad) and picked with weighted randomness, which keeps
 * things fresh while still favouring balanced play.
 *
 * ponytail: candidates are sampled (SAMPLES shuffles), not exhaustively
 * enumerated. Enumerating every partition is factorial — 12 players is 5,775
 * groupings but 20 players is ~11 billion. Sampling is O(SAMPLES * n) and gets
 * a good-enough assignment. Raise SAMPLES if assignments feel too random.
 */

const SAMPLES = 600;
const DEFAULT_ELO_TOLERANCE = 100;

export interface AssignPlayer {
  id: string;
  elo: number;
}

export interface Net {
  team1: AssignPlayer[];
  team2: AssignPlayer[];
}

export interface RoundAssignment {
  nets: Net[];
  /** Team with no opponent this round (odd team count). Rotates between rounds. */
  bye: AssignPlayer[];
}

/** Times each unordered pair has already shared a net. Key: `${idA}|${idB}` sorted. */
export type PairHistory = Record<string, number>;

/** Times each player has already sat out a round. */
export type ByeHistory = Record<string, number>;

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const avgElo = (group: AssignPlayer[]) =>
  group.reduce((s, p) => s + p.elo, 0) / group.length;

/** Tight ELO spread scores near 1, wide spread decays toward 0. */
function eloSpreadScore(group: AssignPlayer[], eloTolerance: number): number {
  if (group.length < 2) return 1;
  const mean = avgElo(group);
  const variance = group.reduce((s, p) => s + (p.elo - mean) ** 2, 0) / group.length;
  return Math.exp(-((Math.sqrt(variance) / eloTolerance) ** 2));
}

/** Every previous shared net between two members multiplies the score down. */
function repeatPenalty(group: AssignPlayer[], history: PairHistory): number {
  let penalty = 1;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      penalty *= 1 / (1 + (history[pairKey(group[i].id, group[j].id)] ?? 0));
    }
  }
  return penalty;
}

/**
 * Team sizes for n players: everyone pairs up, and when n is odd exactly one
 * team takes a third player. 12 -> six 2s. 13 -> five 2s and one 3.
 */
export function teamSizes(n: number): number[] {
  if (n < 2) return [];
  const teams = Math.floor(n / 2);
  const sizes = Array(teams).fill(2);
  if (n % 2 === 1) sizes[teams - 1] = 3; // odd player joins the last team
  return sizes;
}

function shuffled<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * One candidate: jitter each ELO, sort, then slice into teams. The jitter is
 * what lets a top-8 player team with a top-4 player instead of the same names
 * every round; its width is the ELO tolerance. Sorting first is what stops the
 * strongest and weakest player landing on the same team.
 */
function candidateTeams(players: AssignPlayer[], sizes: number[], tol: number): AssignPlayer[][] {
  const jittered = shuffled(players)
    .map((p) => ({ p, key: p.elo + (Math.random() - 0.5) * 2 * tol }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.p);

  // Shuffle the sizes so the 3-player team isn't always the same slice of the
  // ELO order — otherwise the bottom three end up together every single round.
  const order = shuffled(sizes);

  const teams: AssignPlayer[][] = [];
  let cursor = 0;
  for (const size of order) {
    teams.push(jittered.slice(cursor, cursor + size));
    cursor += size;
  }
  return teams;
}

/**
 * Pairs ELO-ordered teams into nets (1st vs 2nd, 3rd vs 4th, ...). With an odd
 * team count the weakest team sits out, but preference goes to whoever has sat
 * out least so byes rotate rather than landing on the same people.
 */
function buildNets(teams: AssignPlayer[][], byes: ByeHistory): { nets: Net[]; bye: AssignPlayer[] } {
  const ranked = [...teams].sort((a, b) => avgElo(b) - avgElo(a));

  let bye: AssignPlayer[] = [];
  if (ranked.length % 2 === 1) {
    const byeCount = (t: AssignPlayer[]) =>
      t.reduce((s, p) => s + (byes[p.id] ?? 0), 0) / t.length;
    // A pair sits out ahead of a trio, so two people idle rather than three.
    // Within that, fewest previous byes goes first so sitting out rotates.
    const eligible = ranked.some((t) => t.length === 2)
      ? ranked.filter((t) => t.length === 2)
      : ranked;
    let chosen = eligible[0];
    for (const t of eligible) {
      if (byeCount(t) < byeCount(chosen)) chosen = t;
    }
    bye = chosen;
    ranked.splice(ranked.indexOf(chosen), 1);
  }

  const nets: Net[] = [];
  for (let i = 0; i + 1 < ranked.length; i += 2) {
    nets.push({ team1: ranked[i], team2: ranked[i + 1] });
  }
  return { nets, bye };
}

/** Scores one full round: team tightness, net tightness, and repeat avoidance. */
function scoreRound(nets: Net[], history: PairHistory, tol: number): number {
  let score = 1;
  for (const { team1, team2 } of nets) {
    // Within-team spread — keeps the top player off the bottom player's team.
    score *= eloSpreadScore(team1, tol) * eloSpreadScore(team2, tol);
    // Across-the-net spread — keeps the matchup competitive. Compared on
    // averages, since a 3-player team's total is meaningless against a 2's.
    score *= eloSpreadScore(
      [{ id: 't1', elo: avgElo(team1) }, { id: 't2', elo: avgElo(team2) }],
      tol,
    );
    // Repeats: same teammates or same opponents as a previous round.
    score *= repeatPenalty([...team1, ...team2], history);
  }
  return score;
}

/**
 * Splits players into teams and matches those teams onto nets.
 * Nets come back strongest-first.
 */
export function assignRound(
  players: AssignPlayer[],
  history: PairHistory = {},
  byes: ByeHistory = {},
  eloTolerance: number = DEFAULT_ELO_TOLERANCE,
): RoundAssignment {
  const sizes = teamSizes(players.length);
  if (sizes.length < 2) return { nets: [], bye: players.length ? players : [] };

  const candidates: RoundAssignment[] = [];
  const weights: number[] = [];

  for (let i = 0; i < SAMPLES; i++) {
    const teams = candidateTeams(players, sizes, eloTolerance);
    const { nets, bye } = buildNets(teams, byes);
    candidates.push({ nets, bye });
    // Squared so good rounds dominate without the best one winning every time.
    weights.push(scoreRound(nets, history, eloTolerance) ** 2);
  }

  // Weighted pick, not argmax: argmax would hand the same players the same
  // teams every round, which is exactly what the rotation is meant to avoid.
  const total = weights.reduce((a, b) => a + b, 0);
  let picked = candidates[Math.floor(Math.random() * candidates.length)];
  if (total > 0) {
    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        picked = candidates[i];
        break;
      }
    }
  }

  picked.nets.sort((a, b) => avgElo([...b.team1, ...b.team2]) - avgElo([...a.team1, ...a.team2]));
  return picked;
}

/** Records this round so the next one avoids repeating teammates, opponents and byes. */
export function updateHistory(
  round: RoundAssignment,
  history: PairHistory,
  byes: ByeHistory,
): void {
  for (const { team1, team2 } of round.nets) {
    const net = [...team1, ...team2];
    for (let i = 0; i < net.length; i++) {
      for (let j = i + 1; j < net.length; j++) {
        const k = pairKey(net[i].id, net[j].id);
        history[k] = (history[k] ?? 0) + 1;
      }
    }
  }
  for (const p of round.bye) byes[p.id] = (byes[p.id] ?? 0) + 1;
}
