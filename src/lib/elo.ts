const K_PLACEMENT = 60;
const K_STANDARD = 24;

function expectedScore(playerElo: number, opponentElo: number) {
  return 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
}

export function calculate2v2(
  team1Elos: [number, number],
  team2Elos: [number, number],
  winningTeam: 1 | 2,
  placementCounts: [number, number, number, number],
): { deltas: [number, number, number, number]; newElos: [number, number, number, number] } {
  const allElos = [...team1Elos, ...team2Elos] as [number, number, number, number];
  const kFactors = placementCounts.map((p) => (p < 10 ? K_PLACEMENT : K_STANDARD));
  const avgTeam1 = (team1Elos[0] + team1Elos[1]) / 2;
  const avgTeam2 = (team2Elos[0] + team2Elos[1]) / 2;

  const deltas = allElos.map((elo, i) => {
    const opponentAvg = i < 2 ? avgTeam2 : avgTeam1;
    const playerTeam = i < 2 ? 1 : 2;
    const expected = expectedScore(elo, opponentAvg);
    const actual = playerTeam === winningTeam ? 1 : 0;
    return Math.round(kFactors[i] * (actual - expected));
  }) as [number, number, number, number];

  const newElos = allElos.map((elo, i) =>
    Math.max(100, elo + deltas[i]),
  ) as [number, number, number, number];

  return { deltas, newElos };
}
