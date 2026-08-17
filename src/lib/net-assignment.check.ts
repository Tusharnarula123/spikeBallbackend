/**
 * Self-check for team/net assignment.
 * Run: npx ts-node -T src/lib/net-assignment.check.ts
 */
import assert from 'assert';
import {
  assignRound, teamSizes, updateHistory, pairKey,
  PairHistory, ByeHistory, AssignPlayer, RoundAssignment,
} from './net-assignment';

const mk = (n: number): AssignPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, elo: 800 + i * 40 }));

const everyone = (r: RoundAssignment) =>
  [...r.nets.flatMap((n) => [...n.team1, ...n.team2]), ...r.bye];

// ── team sizes: pair up, one team of 3 when odd ──
assert.deepStrictEqual(teamSizes(12), [2, 2, 2, 2, 2, 2]);
assert.deepStrictEqual(teamSizes(13), [2, 2, 2, 2, 2, 3]);
assert.deepStrictEqual(teamSizes(14), [2, 2, 2, 2, 2, 2, 2]);
assert.deepStrictEqual(teamSizes(15), [2, 2, 2, 2, 2, 2, 3]);
assert.deepStrictEqual(teamSizes(7),  [2, 2, 3]);
assert.deepStrictEqual(teamSizes(3),  [3]);
assert.deepStrictEqual(teamSizes(1),  []);
for (const n of [3, 7, 12, 13, 14, 15, 20, 23]) {
  assert.strictEqual(teamSizes(n).reduce((a, b) => a + b, 0), n, `sizes must total ${n}`);
  assert.ok(teamSizes(n).filter((s) => s === 3).length <= 1, `${n}: at most one 3-player team`);
}

// ── every player placed exactly once, teams are 2 or 3 ──
for (const n of [12, 13, 14, 15, 20, 23]) {
  const round = assignRound(mk(n));
  const ids = everyone(round).map((p) => p.id);
  assert.strictEqual(ids.length, n, `${n}: all players placed`);
  assert.strictEqual(new Set(ids).size, n, `${n}: nobody placed twice`);
  for (const net of round.nets) {
    for (const team of [net.team1, net.team2]) {
      assert.ok(team.length === 2 || team.length === 3, `${n}: team of ${team.length}`);
    }
  }
}

// ── 13 players -> 6 teams -> 3 nets, exactly one of them 3v2, nobody benched ──
{
  const round = assignRound(mk(13));
  assert.strictEqual(round.nets.length, 3, '13 players -> 3 nets');
  assert.strictEqual(round.bye.length, 0, '13 players -> nobody sits');
  const threes = round.nets.filter((n) => n.team1.length === 3 || n.team2.length === 3);
  assert.strictEqual(threes.length, 1, 'exactly one 3v2 net');
}

// ── odd team count -> exactly one team sits out ──
{
  const round = assignRound(mk(14)); // 7 teams
  assert.strictEqual(round.nets.length, 3, '14 players -> 3 nets');
  assert.strictEqual(round.bye.length, 2, '14 players -> one 2-player team sits');
  assert.strictEqual(everyone(round).length, 14, 'bye players still accounted for');
}

// ── byes rotate instead of hitting the same people ──
{
  const history: PairHistory = {};
  const byes: ByeHistory = {};
  for (let i = 0; i < 8; i++) updateHistory(assignRound(mk(14), history, byes), history, byes);
  const counts = Object.values(byes);
  assert.ok(counts.length > 2, 'byes should spread across more than one team');
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 2, 'bye counts stay balanced');
}

// ── late signups: the next round re-forms teams around the new roster ──
// 13 players carry one team of 3; a 14th arriving must split that trio into
// two pairs, and a 15th must produce a single trio again — without anyone
// being dropped.
{
  const history: PairHistory = {};
  const byes: ByeHistory = {};

  const trios = (n: number) => {
    const round = assignRound(mk(n), history, byes);
    const all = everyone(round);
    assert.strictEqual(all.length, n, `${n}: late signup must not drop anyone`);
    assert.strictEqual(new Set(all.map((p) => p.id)).size, n, `${n}: nobody duplicated`);
    const teams = [...round.nets.flatMap((net) => [net.team1, net.team2])];
    if (round.bye.length) teams.push(round.bye);
    return teams.filter((t) => t.length === 3).length;
  };

  assert.strictEqual(trios(13), 1, '13 players -> exactly one team of 3');
  assert.strictEqual(trios(14), 0, '14th player splits the trio into two pairs');
  assert.strictEqual(trios(15), 1, '15th player re-forms a single trio');
  assert.strictEqual(trios(16), 0, '16 players -> all pairs');

  // A pair sits out ahead of a trio, so a bye idles two people, never three.
  // Only odd rosters whose team count is also odd have both a trio and a bye.
  for (const n of [15, 19, 23]) {
    assert.ok(teamSizes(n).length % 2 === 1, `${n} should produce an odd team count`);
    for (let i = 0; i < 20; i++) {
      const round = assignRound(mk(n), history, byes);
      assert.strictEqual(round.bye.length, 2, `${n}: a bye should sit out a pair, not a trio`);
    }
  }
  // Even team counts have nobody sitting out at all.
  for (const n of [13, 16, 17]) {
    assert.strictEqual(assignRound(mk(n), history, byes).bye.length, 0, `${n}: nobody should sit out`);
  }
}

// ── the 3-player team rotates, it isn't always the same (weakest) three ──
// Regression guard: sizes used to be applied in fixed order, so the last slice
// of the ELO-sorted field — the bottom three — got stuck together every round.
{
  const history: PairHistory = {};
  const byes: ByeHistory = {};
  const trios = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const round = assignRound(mk(13), history, byes);
    for (const net of round.nets) {
      for (const team of [net.team1, net.team2]) {
        if (team.length === 3) trios.add(team.map((p) => p.id).sort().join(','));
      }
    }
    updateHistory(round, history, byes);
  }
  assert.ok(trios.size > 3, `3-player team must rotate (saw only ${trios.size} distinct trios)`);
}

// ── teams are ELO-similar: never the top player with the bottom player ──
{
  const players = mk(20); // p1 = 800 (worst) ... p20 = 1560 (best)
  const worst = 'p1';
  const best  = 'p20';
  for (let i = 0; i < 40; i++) {
    for (const net of assignRound(players).nets) {
      for (const team of [net.team1, net.team2]) {
        const ids = team.map((p) => p.id);
        assert.ok(
          !(ids.includes(worst) && ids.includes(best)),
          'top and bottom player must never share a team',
        );
      }
    }
  }
}

// ── matchups are competitive: team averages within a net stay close ──
{
  const avg = (t: AssignPlayer[]) => t.reduce((s, p) => s + p.elo, 0) / t.length;
  const gaps: number[] = [];
  for (let i = 0; i < 20; i++) {
    for (const net of assignRound(mk(20)).nets) gaps.push(Math.abs(avg(net.team1) - avg(net.team2)));
  }
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(meanGap < 200, `net matchups should be close on ELO (mean gap ${meanGap.toFixed(0)})`);
}

// ── randomness: the strongest team is not the same two players every round ──
{
  const seen = new Set(
    Array.from({ length: 30 }, () => assignRound(mk(20)).nets[0].team1.map((p) => p.id).sort().join(',')),
  );
  assert.ok(seen.size > 1, 'top team must vary between rounds, not lock the top players together');
}

// ── repeat penalty pushes players apart in later rounds ──
{
  const history: PairHistory = {};
  const byes: ByeHistory = {};
  const round1 = assignRound(mk(12), history, byes);
  updateHistory(round1, history, byes);
  assert.ok(Object.keys(history).length > 0, 'history recorded after a round');

  const repeats = (r: RoundAssignment) =>
    r.nets.reduce((count, net) => {
      const all = [...net.team1, ...net.team2];
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++)
          if ((history[pairKey(all[i].id, all[j].id)] ?? 0) > 0) count++;
      return count;
    }, 0);

  assert.ok(repeats(assignRound(mk(12), history, byes)) < repeats(round1),
    'round 2 should repeat fewer pairings than round 1 did');
}

console.log('net-assignment: all checks passed');
