import { HttpStatus, Injectable } from '@nestjs/common';
import { ClerkUser } from '../auth/auth.types';
import { apiError } from '../common/api-error';
import { getPlayerByClerkId } from '../common/player.helpers';
import { MailService } from '../lib/mail.service';
import { NotificationsService, CreateNotificationInput } from '../notifications/notifications.service';
import { SupabaseService } from '../supabase/supabase.service';

interface Registration {
  id: string;
  player_id: string;
  preferred_partner_id: string | null;
  team_id: string | null;
}

@Injectable()
export class TournamentsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifs: NotificationsService,
    private readonly mail: MailService,
  ) {}

  async list(status?: string) {
    let query = this.supabase.db
      .from('tournaments')
      .select('*, tournament_registrations(count)')
      .order('start_date', { ascending: true });

    if (status) {
      const statuses = status.split(',').map((s) => s.trim());
      query = query.in('status', statuses);
    }

    const { data, error } = await query;
    if (error) apiError(error.message);

    return (data ?? []).map((t: Record<string, unknown>) => ({
      ...t,
      registration_count:
        (t.tournament_registrations as { count: number }[] | undefined)?.[0]?.count ?? 0,
      tournament_registrations: undefined,
    }));
  }

  async create(auth: ClerkUser, body: Record<string, unknown>) {
    const admin = await getPlayerByClerkId(this.supabase, auth.userId);

    const {
      name,
      description,
      isCasual,
      affectsElo,
      teamFormation,
      tournamentType,
      seasonId,
      startDate,
      endDate,
      status,
    } = body;

    if (!name || !startDate) apiError('name and startDate are required');
    if (teamFormation && !['random', 'self_select'].includes(teamFormation as string)) {
      apiError('teamFormation must be "random" or "self_select"');
    }
    if (tournamentType && !['bracket', 'round_robin'].includes(tournamentType as string)) {
      apiError('tournamentType must be "bracket" or "round_robin"');
    }

    const { data, error } = await this.supabase.db
      .from('tournaments')
      .insert({
        name,
        description: description ?? null,
        is_casual: !!isCasual,
        affects_elo: affectsElo ?? !isCasual,
        team_formation: teamFormation ?? 'random',
        tournament_type: tournamentType ?? 'bracket',
        season_id: seasonId ?? null,
        start_date: startDate,
        end_date: endDate ?? null,
        status: status ?? 'registration_open',
        created_by: admin?.id ?? null,
      })
      .select()
      .single();

    if (error) apiError(error.message);
    return data;
  }

  async getById(id: string) {
    const { data: tournament, error } = await this.supabase.db
      .from('tournaments')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !tournament) apiError('Tournament not found', HttpStatus.NOT_FOUND);

    const { count } = await this.supabase.db
      .from('tournament_registrations')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', id);

    return { ...tournament, registration_count: count ?? 0 };
  }

  async update(id: string, body: Record<string, unknown>) {
    const allowed = [
      'name',
      'description',
      'isCasual',
      'affectsElo',
      'teamFormation',
      'tournamentType',
      'seasonId',
      'startDate',
      'endDate',
      'status',
    ] as const;

    const fieldMap: Record<string, string> = {
      isCasual: 'is_casual',
      affectsElo: 'affects_elo',
      teamFormation: 'team_formation',
      tournamentType: 'tournament_type',
      seasonId: 'season_id',
      startDate: 'start_date',
      endDate: 'end_date',
    };

    const update: Record<string, unknown> = {};
    for (const key of allowed) {
      if (body[key] !== undefined) {
        update[fieldMap[key] ?? key] = body[key];
      }
    }

    if (Object.keys(update).length === 0) apiError('No valid fields to update');

    if (
      update.team_formation &&
      !['random', 'self_select'].includes(update.team_formation as string)
    ) {
      apiError('teamFormation must be "random" or "self_select"');
    }
    if (
      update.tournament_type &&
      !['bracket', 'round_robin'].includes(update.tournament_type as string)
    ) {
      apiError('tournamentType must be "bracket" or "round_robin"');
    }
    if (
      update.status &&
      !['upcoming', 'registration_open', 'in_progress', 'completed', 'cancelled'].includes(
        update.status as string,
      )
    ) {
      apiError('Invalid status');
    }

    const { data, error } = await this.supabase.db
      .from('tournaments')
      .update(update)
      .eq('id', id)
      .select()
      .single();

    if (error) apiError(error.message);
    return data;
  }

  async deleteTournament(id: string) {
    // Delete dependent records first
    const { data: matches } = await this.supabase.db
      .from('matches')
      .select('id')
      .eq('tournament_id', id);

    if (matches && matches.length > 0) {
      const matchIds = matches.map(m => m.id);
      await this.supabase.db.from('player_badges').delete().in('match_id', matchIds);
      await this.supabase.db.from('elo_history').delete().in('match_id', matchIds);
      await this.supabase.db.from('matches').delete().eq('tournament_id', id);
    }

    await this.supabase.db.from('tournament_teams').delete().eq('tournament_id', id);
    await this.supabase.db.from('tournament_registrations').delete().eq('tournament_id', id);

    const { error } = await this.supabase.db.from('tournaments').delete().eq('id', id);
    if (error) apiError(error.message);
    return { deleted: true };
  }

  async getMyRegistrations(auth: ClerkUser) {
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    const { data, error } = await this.supabase.db
      .from('tournament_registrations')
      .select(`
        id, registered_at, preferred_partner_id, team_id,
        tournament:tournaments ( * ),
        team:tournament_teams!team_id (
          id, player1_id, player2_id,
          player1:players!player1_id ( id, first_name, last_name ),
          player2:players!player2_id ( id, first_name, last_name )
        )
      `)
      .eq('player_id', player.id)
      .order('registered_at', { ascending: false });

    if (error) apiError(error.message);

    return (data ?? []).map((row: Record<string, unknown>) => {
      let partner: { id: string; name: string } | null = null;
      const team = row.team as Record<string, unknown> | null;
      if (team) {
        const isP1 = team.player1_id === player.id;
        const partnerRow = (isP1 ? team.player2 : team.player1) as
          | { id: string; first_name: string; last_name: string }
          | null;
        if (partnerRow) {
          partner = {
            id: partnerRow.id,
            name: `${partnerRow.first_name} ${partnerRow.last_name}`,
          };
        }
      }
      return {
        registrationId: row.id,
        registeredAt: row.registered_at,
        preferredPartnerId: row.preferred_partner_id,
        tournament: row.tournament,
        teamId: row.team_id,
        partner,
      };
    });
  }

  async register(auth: ClerkUser, tournamentId: string, body: Record<string, unknown>) {
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player || player.status !== 'active') {
      apiError('Only active players can register for tournaments', HttpStatus.FORBIDDEN);
    }

    const { data: tournament } = await this.supabase.db
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .single();
    if (!tournament) apiError('Tournament not found', HttpStatus.NOT_FOUND);
    if (tournament.status !== 'registration_open') {
      apiError('Registration is not open for this tournament');
    }

    const preferredPartnerId = (body?.preferredPartnerId as string | null) ?? null;

    if (preferredPartnerId === player.id) {
      apiError('You cannot select yourself as a teammate');
    }

    const { data, error } = await this.supabase.db
      .from('tournament_registrations')
      .insert({
        tournament_id: tournamentId,
        player_id: player.id,
        preferred_partner_id: preferredPartnerId,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        apiError('You are already registered for this tournament');
      }
      apiError(error.message);
    }
    return data;
  }

  async unregister(auth: ClerkUser, tournamentId: string) {
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    const { data: tournament } = await this.supabase.db
      .from('tournaments')
      .select('status')
      .eq('id', tournamentId)
      .single();
    if (tournament && tournament.status === 'in_progress') {
      apiError('Cannot withdraw once the tournament is in progress');
    }

    const { error } = await this.supabase.db
      .from('tournament_registrations')
      .delete()
      .eq('tournament_id', tournamentId)
      .eq('player_id', player.id);

    if (error) apiError(error.message);
    return { success: true };
  }

  async listRegistrations(tournamentId: string) {
    const { data, error } = await this.supabase.db
      .from('tournament_registrations')
      .select(`
        id, registered_at, preferred_partner_id, team_id,
        player:players!player_id ( id, first_name, last_name, email, age, gender, university, current_elo ),
        preferred_partner:players!preferred_partner_id ( id, first_name, last_name ),
        team:tournament_teams!team_id ( id, player1_id, player2_id )
      `)
      .eq('tournament_id', tournamentId)
      .order('registered_at', { ascending: true });

    if (error) apiError(error.message);
    return data;
  }

  async getBracket(tournamentId: string) {
    const { data: tournament, error: tErr } = await this.supabase.db
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .single();
    if (tErr || !tournament) apiError('Tournament not found', HttpStatus.NOT_FOUND);

    // Fetch ALL tournament matches (bracket + RR pool + finals)
    const { data: matches, error: mErr } = await this.supabase.db
      .from('matches')
      .select(`
        id, bracket_round, bracket_slot, rr_pool, status,
        winning_team, score_team1, score_team2,
        team1_player1_id, team1_player2_id, team2_player1_id, team2_player2_id,
        team1_player1:players!team1_player1_id ( id, first_name, last_name ),
        team1_player2:players!team1_player2_id ( id, first_name, last_name ),
        team2_player1:players!team2_player1_id ( id, first_name, last_name ),
        team2_player2:players!team2_player2_id ( id, first_name, last_name )
      `)
      .eq('tournament_id', tournamentId)
      .order('rr_pool',      { ascending: true, nullsFirst: false })
      .order('bracket_round', { ascending: true, nullsFirst: false })
      .order('bracket_slot',  { ascending: true });

    if (mErr) apiError(mErr.message);

    // ── Round Robin ────────────────────────────────────────────────────────────
    if ((tournament as Record<string, unknown>).tournament_type === 'round_robin') {
      const poolMatchMap = new Map<number, unknown[]>();
      const finalsMatches: unknown[] = [];

      for (const m of (matches ?? []) as Record<string, unknown>[]) {
        if (m.rr_pool !== null && m.rr_pool !== undefined) {
          const p = m.rr_pool as number;
          if (!poolMatchMap.has(p)) poolMatchMap.set(p, []);
          poolMatchMap.get(p)!.push(m);
        } else if (m.bracket_round !== null && m.bracket_round !== undefined) {
          finalsMatches.push(m);
        }
      }

      // Fetch teams for standings computation
      type TeamRow = {
        id: string;
        player1_id: string;
        player2_id: string;
        player1: { id: string; first_name: string; last_name: string };
        player2: { id: string; first_name: string; last_name: string };
      };
      const { data: teams } = await this.supabase.db
        .from('tournament_teams')
        .select(`
          id, player1_id, player2_id,
          player1:players!player1_id ( id, first_name, last_name ),
          player2:players!player2_id ( id, first_name, last_name )
        `)
        .eq('tournament_id', tournamentId);

      const teamsByKey = new Map<string, TeamRow>();
      for (const t of (teams ?? []) as unknown as TeamRow[]) {
        teamsByKey.set(`${t.player1_id}:${t.player2_id}`, t);
        teamsByKey.set(`${t.player2_id}:${t.player1_id}`, t);
      }

      type Standing = { teamId: string; name: string; wins: number; losses: number; pool: number };
      const standingsByTeam = new Map<string, Standing>();
      const poolTeamIds     = new Map<number, Set<string>>();

      for (const m of (matches ?? []) as Record<string, unknown>[]) {
        if (m.rr_pool === null || m.rr_pool === undefined) continue;
        const pool = m.rr_pool as number;
        const t1 = teamsByKey.get(`${m.team1_player1_id}:${m.team1_player2_id}`)
                ?? teamsByKey.get(`${m.team1_player2_id}:${m.team1_player1_id}`);
        const t2 = teamsByKey.get(`${m.team2_player1_id}:${m.team2_player2_id}`)
                ?? teamsByKey.get(`${m.team2_player2_id}:${m.team2_player1_id}`);

        for (const team of [t1, t2]) {
          if (!team) continue;
          if (!standingsByTeam.has(team.id)) {
            standingsByTeam.set(team.id, {
              teamId: team.id,
              name: `${(team.player1 as { first_name: string }).first_name} & ${(team.player2 as { first_name: string }).first_name}`,
              wins: 0, losses: 0, pool,
            });
          }
          if (!poolTeamIds.has(pool)) poolTeamIds.set(pool, new Set());
          poolTeamIds.get(pool)!.add(team.id);
        }

        if (m.status === 'approved' && m.winning_team) {
          const winner = m.winning_team === 1 ? t1 : t2;
          const loser  = m.winning_team === 1 ? t2 : t1;
          if (winner && standingsByTeam.has(winner.id)) standingsByTeam.get(winner.id)!.wins++;
          if (loser  && standingsByTeam.has(loser.id))  standingsByTeam.get(loser.id)!.losses++;
        }
      }

      const poolCount = poolMatchMap.size;
      const pools = Array.from({ length: poolCount }, (_, i) => ({
        pool: i,
        label: String.fromCharCode(65 + i),
        matches: poolMatchMap.get(i) ?? [],
        standings: Array.from(poolTeamIds.get(i) ?? [])
          .map(id => standingsByTeam.get(id)!)
          .filter(Boolean)
          .sort((a, b) => b.wins - a.wins || a.losses - b.losses),
      }));

      const rounds = finalsMatches.length > 0
        ? [{ round: 99, label: 'Finals', matches: finalsMatches }]
        : [];

      return { tournament, rounds, pools };
    }

    // ── Bracket (default) ──────────────────────────────────────────────────────
    const roundsMap = new Map<number, unknown[]>();
    for (const m of (matches ?? []) as Record<string, unknown>[]) {
      if (m.bracket_round === null || m.bracket_round === undefined) continue;
      const round = m.bracket_round as number;
      if (!roundsMap.has(round)) roundsMap.set(round, []);
      roundsMap.get(round)!.push(m);
    }

    const rounds = Array.from(roundsMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([round, roundMatches]) => ({ round, matches: roundMatches }));

    return { tournament, rounds, pools: [] };
  }

  async generateRoundRobin(tournamentId: string) {
    const { data: tournament } = await this.supabase.db
      .from('tournaments')
      .select('id, name, status, season_id, tournament_type')
      .eq('id', tournamentId)
      .single();
    if (!tournament) apiError('Tournament not found', HttpStatus.NOT_FOUND);
    if ((tournament as Record<string, unknown>).tournament_type !== 'round_robin') {
      apiError('This tournament is not configured as Round Robin');
    }

    // Prevent duplicate schedule
    const { count } = await this.supabase.db
      .from('matches')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId)
      .not('rr_pool', 'is', null);
    if ((count ?? 0) > 0) apiError('Round Robin schedule already generated');

    const { data: teams, error: teamsError } = await this.supabase.db
      .from('tournament_teams')
      .select('id, player1_id, player2_id')
      .eq('tournament_id', tournamentId);
    if (teamsError) apiError('Failed to load teams');
    if (!teams || teams.length < 2) apiError('Need at least 2 teams to generate a schedule');

    // Resolve season_id
    let seasonId = (tournament as Record<string, unknown>).season_id as string | null;
    if (!seasonId) {
      const { data: activeSeason } = await this.supabase.db
        .from('seasons')
        .select('id')
        .eq('is_active', true)
        .single();
      if (!activeSeason) apiError('No season linked to this tournament and no active season found');
      seasonId = activeSeason!.id;
    }

    // Shuffle teams (Fisher-Yates)
    const shuffled = [...teams];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Compute number of pools: p = round(n/5), then clamp so each pool has 4–7 teams
    const n = shuffled.length;
    let p = Math.round(n / 5) || 1;
    while (p > 1 && n / p < 4) p--;
    while (n / p > 7) p++;

    // Distribute teams as evenly as possible across p pools
    const base = Math.floor(n / p);
    const extra = n % p; // first `extra` pools get one extra team
    const pools: typeof shuffled[] = [];
    let cursor = 0;
    for (let i = 0; i < p; i++) {
      const size = base + (i < extra ? 1 : 0);
      pools.push(shuffled.slice(cursor, cursor + size));
      cursor += size;
    }

    // Generate all N*(N-1)/2 match pairs per pool
    const matchInserts: Record<string, unknown>[] = [];
    for (let poolIdx = 0; poolIdx < pools.length; poolIdx++) {
      const pool = pools[poolIdx];
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          matchInserts.push({
            season_id:        seasonId,
            tournament_id:    tournamentId,
            team1_player1_id: pool[i].player1_id,
            team1_player2_id: pool[i].player2_id,
            team2_player1_id: pool[j].player1_id,
            team2_player2_id: pool[j].player2_id,
            status:           'pending',
            rr_pool:          poolIdx,
          });
        }
      }
    }

    const { data: created, error: insertError } = await this.supabase.db
      .from('matches')
      .insert(matchInserts)
      .select('id');
    if (insertError) apiError(insertError.message);

    // Advance tournament status
    if (
      (tournament as Record<string, unknown>).status === 'registration_open' ||
      (tournament as Record<string, unknown>).status === 'upcoming'
    ) {
      await this.supabase.db
        .from('tournaments')
        .update({ status: 'in_progress' })
        .eq('id', tournamentId);
    }

    return {
      matchesCreated: created?.length ?? 0,
      pools: pools.map((p, i) => ({
        pool: i,
        label: String.fromCharCode(65 + i),
        teams: p.length,
        matches: (p.length * (p.length - 1)) / 2,
      })),
      message: `Generated ${created?.length} match${(created?.length ?? 0) === 1 ? '' : 'es'} across ${pools.length} pool${pools.length > 1 ? 's' : ''}.`,
    };
  }

  async generateRRFinals(tournamentId: string) {
    const { data: tournament } = await this.supabase.db
      .from('tournaments')
      .select('id, name, season_id, tournament_type')
      .eq('id', tournamentId)
      .single();
    if (!tournament) apiError('Tournament not found', HttpStatus.NOT_FOUND);
    if ((tournament as Record<string, unknown>).tournament_type !== 'round_robin') {
      apiError('Not a Round Robin tournament');
    }

    // Check finals doesn't already exist
    const { count: existingFinals } = await this.supabase.db
      .from('matches')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId)
      .is('rr_pool', null)
      .not('bracket_round', 'is', null);
    if ((existingFinals ?? 0) > 0) apiError('Finals match already exists');

    // Get pool matches (all statuses) to compute standings
    const { data: poolMatches } = await this.supabase.db
      .from('matches')
      .select('id, rr_pool, status, winning_team, team1_player1_id, team1_player2_id, team2_player1_id, team2_player2_id')
      .eq('tournament_id', tournamentId)
      .not('rr_pool', 'is', null);

    if (!poolMatches || poolMatches.length === 0) apiError('No pool matches found — generate schedule first');

    const poolIndices = [...new Set(poolMatches.map(m => m.rr_pool as number))].sort((a, b) => a - b);
    if (poolIndices.length < 2) apiError('Single-pool tournament — pool winner wins without a finals match');

    // Get tournament teams
    const { data: teams } = await this.supabase.db
      .from('tournament_teams')
      .select('id, player1_id, player2_id')
      .eq('tournament_id', tournamentId);

    const teamsByKey = new Map<string, { id: string; player1_id: string; player2_id: string }>();
    for (const t of teams ?? []) {
      teamsByKey.set(`${t.player1_id}:${t.player2_id}`, t);
      teamsByKey.set(`${t.player2_id}:${t.player1_id}`, t);
    }

    // Count wins per team per pool
    const teamWins = new Map<string, number>();
    const teamPoolMap = new Map<string, number>();

    for (const m of poolMatches) {
      const pool = m.rr_pool as number;
      const t1 = teamsByKey.get(`${m.team1_player1_id}:${m.team1_player2_id}`)
              ?? teamsByKey.get(`${m.team1_player2_id}:${m.team1_player1_id}`);
      const t2 = teamsByKey.get(`${m.team2_player1_id}:${m.team2_player2_id}`)
              ?? teamsByKey.get(`${m.team2_player2_id}:${m.team2_player1_id}`);

      for (const team of [t1, t2]) {
        if (!team) continue;
        if (!teamWins.has(team.id)) teamWins.set(team.id, 0);
        teamPoolMap.set(team.id, pool);
      }

      if (m.status === 'approved') {
        const winner = m.winning_team === 1 ? t1 : t2;
        if (winner) teamWins.set(winner.id, (teamWins.get(winner.id) ?? 0) + 1);
      }
    }

    // Find leader per pool
    const poolLeaders: { id: string; player1_id: string; player2_id: string }[] = [];
    for (const poolIdx of poolIndices) {
      let leaderId: string | null = null;
      let maxWins = -1;
      for (const [teamId, wins] of teamWins.entries()) {
        if (teamPoolMap.get(teamId) !== poolIdx) continue;
        if (wins > maxWins) { maxWins = wins; leaderId = teamId; }
      }
      if (!leaderId) apiError(`Could not determine pool ${String.fromCharCode(65 + poolIdx)} leader`);
      const leader = teams?.find(t => t.id === leaderId);
      if (!leader) apiError('Team data missing');
      poolLeaders.push(leader!);
    }

    // Resolve season_id
    let seasonId = (tournament as Record<string, unknown>).season_id as string | null;
    if (!seasonId) {
      const { data: activeSeason } = await this.supabase.db
        .from('seasons').select('id').eq('is_active', true).single();
      if (activeSeason) seasonId = activeSeason.id;
    }

    const { data: finalsMatch, error: finalsError } = await this.supabase.db
      .from('matches')
      .insert({
        season_id:        seasonId,
        tournament_id:    tournamentId,
        team1_player1_id: poolLeaders[0].player1_id,
        team1_player2_id: poolLeaders[0].player2_id,
        team2_player1_id: poolLeaders[1].player1_id,
        team2_player2_id: poolLeaders[1].player2_id,
        status:           'pending',
        bracket_round:    1,
        bracket_slot:     0,
      })
      .select()
      .single();

    if (finalsError) apiError(finalsError.message);

    return {
      finalsMatch,
      message: `Finals match created: Pool A leader vs Pool B leader!`,
    };
  }

  async generateBracket(tournamentId: string) {
    const { data: tournament } = await this.supabase.db
      .from('tournaments')
      .select('id, name, status, season_id')
      .eq('id', tournamentId)
      .single();
    if (!tournament) apiError('Tournament not found', HttpStatus.NOT_FOUND);

    // Prevent duplicate bracket generation
    const { count } = await this.supabase.db
      .from('matches')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId)
      .not('bracket_round', 'is', null);

    if ((count ?? 0) > 0) {
      apiError('Bracket already generated. Delete existing bracket matches first.');
    }

    // Fetch formed teams
    const { data: teams, error: teamsError } = await this.supabase.db
      .from('tournament_teams')
      .select('id, player1_id, player2_id')
      .eq('tournament_id', tournamentId);

    if (teamsError) apiError('Failed to load teams');
    if (!teams || teams.length < 2) apiError('Need at least 2 teams to generate a bracket');

    // Resolve season_id — prefer tournament's season, fall back to active season
    let seasonId = tournament.season_id as string | null;
    if (!seasonId) {
      const activeSeason = await this.supabase.db
        .from('seasons')
        .select('id')
        .eq('is_active', true)
        .single();
      if (!activeSeason.data) apiError('No season linked to this tournament and no active season found');
      seasonId = activeSeason.data!.id;
    }

    // Shuffle teams (Fisher-Yates)
    const shuffled = [...teams];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Pair teams into round 1 matches
    const matchInserts: Record<string, unknown>[] = [];
    for (let i = 0; i + 1 < shuffled.length; i += 2) {
      const t1 = shuffled[i];
      const t2 = shuffled[i + 1];
      matchInserts.push({
        season_id:        seasonId,
        tournament_id:    tournamentId,
        team1_player1_id: t1.player1_id,
        team1_player2_id: t1.player2_id,
        team2_player1_id: t2.player1_id,
        team2_player2_id: t2.player2_id,
        status:           'pending',
        bracket_round:    1,
        bracket_slot:     i / 2,
      });
    }

    const unpaired = shuffled.length % 2 === 1 ? shuffled[shuffled.length - 1] : null;

    const { data: created, error: insertError } = await this.supabase.db
      .from('matches')
      .insert(matchInserts)
      .select('id');

    if (insertError) apiError(insertError.message);

    // Advance tournament to in_progress if still in registration/upcoming
    if (tournament.status === 'registration_open' || tournament.status === 'upcoming') {
      await this.supabase.db
        .from('tournaments')
        .update({ status: 'in_progress' })
        .eq('id', tournamentId);
    }

    const matchCount = created?.length ?? 0;
    const message = unpaired
      ? `Generated ${matchCount} match${matchCount === 1 ? '' : 'es'}. 1 team has no opponent this round.`
      : `Generated ${matchCount} match${matchCount === 1 ? '' : 'es'}. Tournament set to In Progress.`;

    return { matchesCreated: matchCount, unpaired, message };
  }

  async formTeams(tournamentId: string) {
    const { data: tournament } = await this.supabase.db
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .single();
    if (!tournament) apiError('Tournament not found', HttpStatus.NOT_FOUND);

    const { data: registrations, error: regError } = await this.supabase.db
      .from('tournament_registrations')
      .select('id, player_id, preferred_partner_id, team_id')
      .eq('tournament_id', tournamentId)
      .is('team_id', null);

    if (regError) apiError('Failed to load registrations');
    const pool = (registrations ?? []) as Registration[];
    if (pool.length < 2) apiError('Need at least 2 unpaired players to form teams');

    const byPlayer = new Map(pool.map((r) => [r.player_id, r]));
    const paired = new Set<string>();
    const pairs: [string, string][] = [];

    if (tournament.team_formation === 'self_select') {
      for (const reg of pool) {
        if (paired.has(reg.player_id)) continue;
        const partnerId = reg.preferred_partner_id;
        if (!partnerId) continue;
        const partnerReg = byPlayer.get(partnerId);
        if (!partnerReg || paired.has(partnerId)) continue;
        if (partnerReg.preferred_partner_id === reg.player_id) {
          pairs.push([reg.player_id, partnerId]);
          paired.add(reg.player_id);
          paired.add(partnerId);
        }
      }
    }

    const remaining = pool.map((r) => r.player_id).filter((id) => !paired.has(id));
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }

    let unpaired: string | null = null;
    for (let i = 0; i + 1 < remaining.length; i += 2) {
      pairs.push([remaining[i], remaining[i + 1]]);
    }
    if (remaining.length % 2 === 1) unpaired = remaining[remaining.length - 1];

    // Fetch player details for notifications
    const allPlayerIds = pairs.flat();
    const { data: playerRows } = await this.supabase.db
      .from('players')
      .select('id, first_name, last_name, email')
      .in('id', allPlayerIds);

    const playerMap = new Map(
      (playerRows ?? []).map((p) => [p.id, p]),
    );

    const teamsCreated: Record<string, unknown>[] = [];
    const notifBatch: CreateNotificationInput[] = [];
    const mailPromises: Promise<void>[] = [];
    const tournamentLink = `/dashboard/tournaments/${tournamentId}`;

    for (const [p1, p2] of pairs) {
      const { data: team, error: teamError } = await this.supabase.db
        .from('tournament_teams')
        .insert({ tournament_id: tournamentId, player1_id: p1, player2_id: p2 })
        .select()
        .single();
      if (teamError) apiError(teamError.message);

      await this.supabase.db
        .from('tournament_registrations')
        .update({ team_id: team.id })
        .in('player_id', [p1, p2])
        .eq('tournament_id', tournamentId);

      teamsCreated.push(team);

      // Queue in-app notifications + emails for both players
      for (const [pid, partnerPid] of [[p1, p2], [p2, p1]]) {
        const player  = playerMap.get(pid);
        const partner = playerMap.get(partnerPid);
        if (!player || !partner) continue;

        const partnerName = `${partner.first_name} ${partner.last_name}`;
        const title = `You've been teamed up in ${tournament.name}!`;
        const body  = `You'll be playing with ${partnerName} in ${tournament.name}. Head to the tournament bracket to see your matches.`;

        notifBatch.push({
          playerId: pid,
          type: 'team_assigned',
          title,
          body,
          link: tournamentLink,
        });

        if (player.email) {
          mailPromises.push(
            this.mail.sendNotification({
              to: player.email,
              subject: `Team assigned: ${tournament.name}`,
              title,
              body,
              link: tournamentLink,
              linkLabel: 'View Tournament Bracket',
            }),
          );
        }
      }
    }

    // Fire notifications + emails (non-blocking, errors swallowed)
    await Promise.allSettled([
      this.notifs.create(notifBatch),
      ...mailPromises,
    ]);

    return { teamsCreated, unpaired, pairedCount: pairs.length * 2 };
  }
}
