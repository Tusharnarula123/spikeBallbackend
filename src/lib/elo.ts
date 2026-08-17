const K_PLACEMENT = 60;
const K_STANDARD = 24;

function expectedScore(playerElo: number, opponentElo: number) {
  return 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
}

/**
 * ELO for a match between two teams. Teams are normally 2v2, but rotating
 * competitive nets fall back to 2v1 when signups aren't divisible by 4, so
 * team sizes are variable. A team's strength is its average ELO either way,
 * which means the lone player in a 2v1 is rated against the pair's average.
 */
export function calculateTeams(
  team1Elos: number[],
  team2Elos: number[],
  winningTeam: 1 | 2,
  placementCounts: number[],
): { deltas: number[]; newElos: number[] } {
  const allElos = [...team1Elos, ...team2Elos];
  const kFactors = placementCounts.map((p) => (p < 5 ? K_PLACEMENT : K_STANDARD));
  const avg = (elos: number[]) => elos.reduce((s, e) => s + e, 0) / elos.length;
  const avgTeam1 = avg(team1Elos);
  const avgTeam2 = avg(team2Elos);

  const deltas = allElos.map((elo, i) => {
    const onTeam1 = i < team1Elos.length;
    const opponentAvg = onTeam1 ? avgTeam2 : avgTeam1;
    const playerTeam = onTeam1 ? 1 : 2;
    const expected = expectedScore(elo, opponentAvg);
    const actual = playerTeam === winningTeam ? 1 : 0;
    return Math.round(kFactors[i] * (actual - expected));
  });

  const newElos = allElos.map((elo, i) => Math.max(100, elo + deltas[i]));

  return { deltas, newElos };
}

/** 2v2 wrapper — keeps the fixed-tuple types the existing call sites rely on. */
export function calculate2v2(
  team1Elos: [number, number],
  team2Elos: [number, number],
  winningTeam: 1 | 2,
  placementCounts: [number, number, number, number],
): { deltas: [number, number, number, number]; newElos: [number, number, number, number] } {
  const { deltas, newElos } = calculateTeams(team1Elos, team2Elos, winningTeam, placementCounts);
  return {
    deltas: deltas as [number, number, number, number],
    newElos: newElos as [number, number, number, number],
  };
}
