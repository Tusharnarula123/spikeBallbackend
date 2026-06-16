import { SupabaseClient } from '@supabase/supabase-js';

export async function autoAwardBadges(
  supabase: SupabaseClient,
  opts: {
    matchId: string;
    playerIds: string[];
    newElos: number[];
    placementCounts: number[];
  },
): Promise<void> {
  try {
    const { matchId, playerIds, newElos, placementCounts } = opts;

    const { data: badges } = await supabase
      .from('badges')
      .select('id, trigger_type, trigger_value')
      .neq('trigger_type', 'manual');
    if (!badges || badges.length === 0) return;

    const { data: owned } = await supabase
      .from('player_badges')
      .select('player_id, badge_id')
      .in('player_id', playerIds);
    const ownedSet = new Set((owned ?? []).map((o) => `${o.player_id}:${o.badge_id}`));

    const inserts: { player_id: string; badge_id: string; match_id: string }[] = [];

    for (let i = 0; i < playerIds.length; i++) {
      const pid = playerIds[i];

      const needsHistory = badges.some(
        (b) => b.trigger_type === 'match_count' || b.trigger_type === 'win_streak',
      );
      let totalMatches = 0;
      let results: boolean[] = [];

      if (needsHistory) {
        const { data: history } = await supabase
          .from('matches')
          .select('id, winning_team, team1_player1_id, team1_player2_id')
          .eq('status', 'approved')
          .or(
            `team1_player1_id.eq.${pid},team1_player2_id.eq.${pid},` +
              `team2_player1_id.eq.${pid},team2_player2_id.eq.${pid}`,
          )
          .order('approved_at', { ascending: false })
          .limit(200);

        const rows = history ?? [];
        totalMatches = rows.length;
        results = rows.map((m) => {
          const onTeam1 = m.team1_player1_id === pid || m.team1_player2_id === pid;
          return onTeam1 ? m.winning_team === 1 : m.winning_team === 2;
        });
      }

      for (const badge of badges) {
        if (ownedSet.has(`${pid}:${badge.id}`)) continue;

        let earned = false;
        switch (badge.trigger_type) {
          case 'elo_threshold':
            earned = badge.trigger_value != null && newElos[i] >= badge.trigger_value;
            break;
          case 'match_count':
            earned = badge.trigger_value != null && totalMatches >= badge.trigger_value;
            break;
          case 'win_streak': {
            const n = badge.trigger_value ?? 0;
            earned = n > 0 && results.length >= n && results.slice(0, n).every(Boolean);
            break;
          }
          case 'placement_done':
            earned = placementCounts[i] >= 10;
            break;
        }

        if (earned) {
          inserts.push({ player_id: pid, badge_id: badge.id, match_id: matchId });
          ownedSet.add(`${pid}:${badge.id}`);
        }
      }
    }

    if (inserts.length > 0) {
      await supabase
        .from('player_badges')
        .upsert(inserts, { onConflict: 'player_id,badge_id', ignoreDuplicates: true });
    }
  } catch {
    // Badge awarding is best-effort.
  }
}

/** Recompute rank within the active semester after each approved match. */
export async function recomputeSemesterRanks(
  supabase: SupabaseClient,
  semesterId: string,
): Promise<void> {
  try {
    const { data: rows } = await supabase
      .from('player_semester_stats')
      .select('player_id, elo, players!inner(status)')
      .eq('semester_id', semesterId)
      .eq('players.status', 'active')
      .order('elo', { ascending: false });

    if (!rows) return;

    await Promise.all(
      rows.map((r, i) =>
        supabase
          .from('player_semester_stats')
          .update({ rank: i + 1 })
          .eq('player_id', r.player_id)
          .eq('semester_id', semesterId),
      ),
    );
  } catch {
    // Rank caching is best-effort.
  }
}

/** @deprecated Use recomputeSemesterRanks */
export async function recomputeSeasonRanks(
  supabase: SupabaseClient,
  seasonId: string,
): Promise<void> {
  return recomputeSemesterRanks(supabase, seasonId);
}
