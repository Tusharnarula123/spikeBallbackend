import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { DEFAULT_ELO } from '../common/config';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class LeaderboardService {
  constructor(private readonly supabase: SupabaseService) {}

  async getActive(gender?: string) {
    let query = this.supabase.db.from('leaderboard_active').select('*');
    if (gender) query = query.eq('gender', gender);

    const { data, error } = await query;
    if (error) apiError(error.message);

    return (data ?? []).map((p, i) => {
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
        placement_matches_played: p.placement_matches_played ?? 0,
      };
    });
  }

  /** Leaderboard for a specific semester (ELO resets per semester). */
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
