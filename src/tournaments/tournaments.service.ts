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
      seasonId,
      startDate,
      endDate,
      status,
    } = body;

    if (!name || !startDate) apiError('name and startDate are required');
    if (teamFormation && !['random', 'self_select'].includes(teamFormation as string)) {
      apiError('teamFormation must be "random" or "self_select"');
    }

    const { data, error } = await this.supabase.db
      .from('tournaments')
      .insert({
        name,
        description: description ?? null,
        is_casual: !!isCasual,
        affects_elo: affectsElo ?? !isCasual,
        team_formation: teamFormation ?? 'random',
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
      'seasonId',
      'startDate',
      'endDate',
      'status',
    ] as const;

    const fieldMap: Record<string, string> = {
      isCasual: 'is_casual',
      affectsElo: 'affects_elo',
      teamFormation: 'team_formation',
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

    // Fetch all tournament matches with full player info
    const { data: matches, error: mErr } = await this.supabase.db
      .from('matches')
      .select(`
        id, bracket_round, bracket_slot, status,
        winning_team, score_team1, score_team2,
        team1_player1:players!team1_player1_id ( id, first_name, last_name ),
        team1_player2:players!team1_player2_id ( id, first_name, last_name ),
        team2_player1:players!team2_player1_id ( id, first_name, last_name ),
        team2_player2:players!team2_player2_id ( id, first_name, last_name )
      `)
      .eq('tournament_id', tournamentId)
      .order('bracket_round', { ascending: true })
      .order('bracket_slot',  { ascending: true });

    if (mErr) apiError(mErr.message);

    // Group into rounds
    const roundsMap = new Map<number, unknown[]>();
    for (const m of matches ?? []) {
      const round = m.bracket_round ?? 0;
      if (!roundsMap.has(round)) roundsMap.set(round, []);
      roundsMap.get(round)!.push(m);
    }

    const rounds = Array.from(roundsMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([round, roundMatches]) => ({ round, matches: roundMatches }));

    return { tournament, rounds };
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
