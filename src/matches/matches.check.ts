/**
 * Self-check for the competitive-match classification.
 * Run: npx ts-node -T src/matches/matches.check.ts
 *
 * Getting this wrong hides every competitive match from the history filter.
 */
import assert from 'assert';
import { tournamentAffectsElo } from './matches.service';

// PostgREST returns a to-one embed as an object...
assert.strictEqual(tournamentAffectsElo({ affects_elo: true }), true);
assert.strictEqual(tournamentAffectsElo({ affects_elo: false }), false);

// ...but as a single-element array in some shapes. Reading .affects_elo
// straight off the array yielded undefined, so a casual tournament was
// mis-labelled competitive.
assert.strictEqual(tournamentAffectsElo([{ affects_elo: true }]), true);
assert.strictEqual(tournamentAffectsElo([{ affects_elo: false }]), false);

// No tournament (standalone match) or an unusable embed -> undefined, which
// callers treat as "not explicitly excluded", i.e. competitive.
assert.strictEqual(tournamentAffectsElo(null), undefined);
assert.strictEqual(tournamentAffectsElo(undefined), undefined);
assert.strictEqual(tournamentAffectsElo([]), undefined);
assert.strictEqual(tournamentAffectsElo({}), undefined);

// Only a real boolean counts — a null column must not read as false, or the
// match would be wrongly filed as non-competitive.
assert.strictEqual(tournamentAffectsElo({ affects_elo: null }), undefined);

// The rule the history filter applies.
const isCompetitive = (hasEloRow: boolean, embed: unknown) =>
  hasEloRow ? true : tournamentAffectsElo(embed) !== false;

// ELO actually moved -> competitive, whatever the flag claims.
assert.strictEqual(isCompetitive(true, { affects_elo: false }), true);
assert.strictEqual(isCompetitive(true, null), true);
// Not yet approved -> fall back to the tournament's flag.
assert.strictEqual(isCompetitive(false, { affects_elo: false }), false);
assert.strictEqual(isCompetitive(false, { affects_elo: true }), true);
assert.strictEqual(isCompetitive(false, null), true);

console.log('matches competitive-classification: all checks passed');
