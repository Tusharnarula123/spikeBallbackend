import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { DEFAULT_ELO, PLACEMENT_MATCHES_REQUIRED } from '../common/config';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class LeaderboardService {
  constructor(private readonly supabase: SupabaseService) {}

  async getActive(gender?: string) {
    let query = this.supabase.db.from('leaderboard_active').select('*');
    if (gender) query = query.eq('gender', gender);

    const { data, error } = await query;
    if (error) apiError(error.message);

    const rows = data ?? [];

    // leaderboard_active.placement_matches_played is a cached column that reads
    // 0 for anyone whose matches were tagged with a wrong/null semester. Count
    // elo_history instead (one row per player per ELO-affecting match) in a
    // single round-trip, tallied per player in JS.
    const ids = rows.map((p) => p.id).filter(Boolean);
    const { data: eloRows, error: eloError } = ids.length
      ? await this.supabase.db.from('elo_history').select('player_id').in('player_id', ids)
      : { data: [] as { player_id: string }[], error: null };

    const counts = new Map<string, number>();
    if (!eloError) {
      for (const r of (eloRows ?? []) as { player_id: string }[]) {
        counts.set(r.player_id, (counts.get(r.player_id) ?? 0) + 1);
      }
    }

    return rows.map((p, i) => {
      const wins = p.wins ?? 0;
      const losses = p.losses ?? 0;
      const totalMatches = wins + losses;
      return {
        rank: i + 1,
        player_id: p.id,
        display_name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
        gender: p.gender ?? null,
        current_elo: p.elo ?? DEFAULT_ELO,
        peak_elo: p.peak_elo ?? p.elo ?? DEFAULT_ELO,
        wins,
        losses,
        total_matches: totalMatches,
        win_rate: totalMatches > 0 ? (wins / totalMatches) * 100 : 0,
        placement_matches_played: eloError
          ? (p.placement_matches_played ?? 0)
          : Math.min(counts.get(p.id) ?? 0, PLACEMENT_MATCHES_REQUIRED),
      };
    });
  }

  /**
   * Leaderboard for a specific semester (ELO resets per semester).
   * Intentionally reads the cached placement_matches_played counter and so
   * depends on matches/elo_history being tagged with the correct semester_id.
   */
  async getBySemester(semesterId: string, gender?: string) {
    let query = this.supabase.db
      .from('player_semester_stats')
      .select('*, players!inner(id, first_name, last_name, gender, status)')
      .eq('semester_id', semesterId)
      .eq('players.status', 'active')
      .order('elo', { ascending: false });

    if (gender) query = query.eq('players.gender', gender);

    const { data, error } = await query;
    if (error) apiError(error.message);

    return (data ?? []).map((p, i) => ({
      rank: i + 1,
      player_id: (p.players as { id: string }).id,
      display_name: `${(p.players as { first_name: string }).first_name} ${(p.players as { last_name: string }).last_name}`.trim(),
      gender: (p.players as { gender: string }).gender ?? null,
      current_elo: p.elo ?? DEFAULT_ELO,
      peak_elo: p.peak_elo ?? DEFAULT_ELO,
      wins: p.wins ?? 0,
      losses: p.losses ?? 0,
      total_matches: (p.wins ?? 0) + (p.losses ?? 0),
      win_rate: (p.wins ?? 0) + (p.losses ?? 0) > 0 ? ((p.wins ?? 0) / ((p.wins ?? 0) + (p.losses ?? 0))) * 100 : 0,
      placement_matches_played: p.placement_matches_played ?? 0,
    }));
  }

  /** Season aggregate leaderboard — peak ELO across all semesters in the year. */
  async getBySeason(seasonId: string, gender?: string) {
    let query = this.supabase.db
      .from('leaderboard_season')
      .select('*')
      .eq('season_id', seasonId);

    if (gender) query = query.eq('gender', gender);

    const { data, error } = await query;
    if (error) apiError(error.message);

    return (data ?? []).map((p, i) => ({ ...p, rank: i + 1 }));
  }
}
