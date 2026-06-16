import { HttpStatus, Injectable } from '@nestjs/common';
import { ClerkUser } from '../auth/auth.types';
import { apiError } from '../common/api-error';
import { DEFAULT_ELO } from '../common/config';
import { getActiveSemester, getPlayerByClerkId } from '../common/player.helpers';
import { autoAwardBadges, recomputeSemesterRanks } from '../lib/badges';
import { calculate2v2 } from '../lib/elo';
import { MailService } from '../lib/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class MatchesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifs: NotificationsService,
    private readonly mail: MailService,
  ) {}

  async list(query: { playerId?: string; seasonId?: string; semesterId?: string; status?: string }) {
    let q = this.supabase.db
      .from('matches')
      .select('*')
      .order('submitted_at', { ascending: false })
      .limit(50);

    if (query.semesterId) q = q.eq('semester_id', query.semesterId);
    else if (query.seasonId) q = q.eq('season_id', query.seasonId);
    if (query.status) q = q.eq('status', query.status);
    if (query.playerId) {
      q = q.or(
        `team1_player1_id.eq.${query.playerId},team1_player2_id.eq.${query.playerId},` +
          `team2_player1_id.eq.${query.playerId},team2_player2_id.eq.${query.playerId}`,
      );
    }

    const { data, error } = await q;
    if (error) apiError(error.message);
    return data;
  }

  async submit(auth: ClerkUser, body: Record<string, unknown>) {
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player || player.status !== 'active') {
      apiError('Only active players can submit matches', HttpStatus.FORBIDDEN);
    }

    const {
      team1Player1Id,
      team1Player2Id,
      team2Player1Id,
      team2Player2Id,
      winningTeam,
      scoreTeam1,
      scoreTeam2,
      notes,
      tournamentId,
    } = body;

    const playerIds = [
      team1Player1Id,
      team1Player2Id,
      team2Player1Id,
      team2Player2Id,
    ] as string[];

    if (!playerIds.includes(player.id)) {
      apiError('You must be one of the players in the match', HttpStatus.FORBIDDEN);
    }

    const semester = await getActiveSemester(this.supabase);
    if (!semester) apiError('No active semester — an admin must activate a semester before matches can be submitted');

    if (tournamentId) {
      const { data: tournament } = await this.supabase.db
        .from('tournaments')
        .select('id, status')
        .eq('id', tournamentId as string)
        .single();
      if (!tournament) apiError('Tournament not found', HttpStatus.NOT_FOUND);
      if (tournament.status !== 'in_progress') {
        apiError('This tournament is not currently in progress');
      }

      const { data: regs } = await this.supabase.db
        .from('tournament_registrations')
        .select('player_id')
        .eq('tournament_id', tournamentId as string)
        .in('player_id', playerIds);

      if (!regs || regs.length < 4) {
        apiError('All 4 players must be registered for this tournament');
      }
    }

    const { data, error } = await this.supabase.db
      .from('matches')
      .insert({
        season_id:        semester.season_id,
        semester_id:      semester.id,
        team1_player1_id: team1Player1Id,
        team1_player2_id: team1Player2Id,
        team2_player1_id: team2Player1Id,
        team2_player2_id: team2Player2Id,
        winning_team:     winningTeam,
        score_team1:      scoreTeam1,
        score_team2:      scoreTeam2,
        notes,
        submitted_by:     player.id,
        status:           'pending',
        tournament_id:    tournamentId ?? null,
      })
      .select()
      .single();

    if (error) apiError(error.message);

    // Notify all 4 players that a score has been submitted for their approval
    const { data: playerRows } = await this.supabase.db
      .from('players')
      .select('id, first_name, last_name, email')
      .in('id', playerIds);

    const nameMap = new Map(
      (playerRows ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`]),
    );
    const emailMap = new Map(
      (playerRows ?? []).map((p) => [p.id, p.email as string | undefined]),
    );

    const submitterName = nameMap.get(player.id) ?? 'A player';
    const tourney       = tournamentId ? ` (tournament)` : '';

    const notifBatch = playerIds
      .filter((pid) => pid !== player.id) // don't notify the submitter
      .map((pid) => ({
        playerId: pid,
        type: 'match_submitted' as const,
        title:    `Match score submitted${tourney}`,
        body:     `${submitterName} submitted a match result. Please check the result is correct — an admin will approve it shortly.`,
        link:     tournamentId ? `/dashboard/tournaments/${tournamentId as string}` : '/dashboard/history',
      }));

    const mailBatch = playerIds
      .filter((pid) => pid !== player.id)
      .map((pid) => {
        const email = emailMap.get(pid);
        if (!email) return null;
        const link = tournamentId
          ? `/dashboard/tournaments/${tournamentId as string}`
          : '/dashboard/history';
        return this.mail.sendNotification({
          to: email,
          subject: `Match score submitted — ${submitterName}`,
          title: `Match score submitted${tourney}`,
          body: `${submitterName} submitted a match result. Please check the result is correct — an admin will approve it shortly.`,
          link,
          linkLabel: 'View Match',
        });
      })
      .filter(Boolean) as Promise<void>[];

    await Promise.allSettled([
      this.notifs.create(notifBatch),
      ...mailBatch,
    ]);

    return data;
  }

  async getMyMatches(auth: ClerkUser, semesterId?: string, seasonId?: string) {
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    let query = this.supabase.db
      .from('matches')
      .select('*')
      .or(
        `team1_player1_id.eq.${player.id},team1_player2_id.eq.${player.id},` +
          `team2_player1_id.eq.${player.id},team2_player2_id.eq.${player.id}`,
      )
      .order('submitted_at', { ascending: false })
      .limit(100);

    if (semesterId) query = query.eq('semester_id', semesterId);
    else if (seasonId) query = query.eq('season_id', seasonId);

    const { data: matches, error } = await query;
    if (error) apiError(error.message);

    const rows = matches ?? [];
    if (rows.length === 0) return [];

    const ids = new Set<string>();
    for (const m of rows) {
      ids.add(m.team1_player1_id);
      ids.add(m.team1_player2_id);
      ids.add(m.team2_player1_id);
      ids.add(m.team2_player2_id);
    }

    const { data: players } = await this.supabase.db
      .from('players')
      .select('id, first_name, last_name')
      .in('id', Array.from(ids));

    const nameMap = new Map(
      (players ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`]),
    );

    const matchIds = rows.map((m) => m.id);
    const { data: eloRows } = await this.supabase.db
      .from('elo_history')
      .select('match_id, elo_change')
      .eq('player_id', player.id)
      .in('match_id', matchIds);

    const eloMap = new Map((eloRows ?? []).map((e) => [e.match_id, e.elo_change]));

    return rows.map((m) => {
      const onTeam1 =
        m.team1_player1_id === player.id || m.team1_player2_id === player.id;
      const myTeam = onTeam1 ? 1 : 2;

      const partnerId = onTeam1
        ? m.team1_player1_id === player.id
          ? m.team1_player2_id
          : m.team1_player1_id
        : m.team2_player1_id === player.id
          ? m.team2_player2_id
          : m.team2_player1_id;

      const opponentIds = onTeam1
        ? [m.team2_player1_id, m.team2_player2_id]
        : [m.team1_player1_id, m.team1_player2_id];

      const myScore = onTeam1 ? m.score_team1 : m.score_team2;
      const opponentScore = onTeam1 ? m.score_team2 : m.score_team1;

      return {
        id: m.id,
        season_id: m.season_id,
        status: m.status,
        submitted_at: m.submitted_at,
        result:
          m.status === 'approved'
            ? m.winning_team === myTeam
              ? 'win'
              : 'loss'
            : null,
        myScore,
        opponentScore,
        eloChange: eloMap.get(m.id) ?? null,
        partner: { id: partnerId, name: nameMap.get(partnerId) ?? 'Unknown' },
        opponents: opponentIds.map((id) => ({
          id,
          name: nameMap.get(id) ?? 'Unknown',
        })),
      };
    });
  }

  async listPending() {
    const { data, error } = await this.supabase.db
      .from('matches')
      .select(`
        *,
        team1_player1:players!team1_player1_id ( id, first_name, last_name ),
        team1_player2:players!team1_player2_id ( id, first_name, last_name ),
        team2_player1:players!team2_player1_id ( id, first_name, last_name ),
        team2_player2:players!team2_player2_id ( id, first_name, last_name ),
        tournament:tournaments ( id, name, is_casual, affects_elo )
      `)
      .eq('status', 'pending')
      .order('submitted_at', { ascending: true });

    if (error) apiError(error.message);
    return data;
  }

  async update(matchId: string, body: Record<string, unknown>) {
    const { data: match } = await this.supabase.db
      .from('matches')
      .select('status')
      .eq('id', matchId)
      .single();
    if (!match) apiError('Match not found', HttpStatus.NOT_FOUND);
    if (match.status !== 'pending') apiError('Only pending matches can be edited');

    const { winningTeam, scoreTeam1, scoreTeam2, notes } = body;

    const update: Record<string, unknown> = {};
    if (winningTeam !== undefined) {
      if (![1, 2].includes(winningTeam as number)) {
        apiError('winningTeam must be 1 or 2');
      }
      update.winning_team = winningTeam;
    }
    if (scoreTeam1 !== undefined) {
      if (typeof scoreTeam1 !== 'number' || (scoreTeam1 as number) < 0) {
        apiError('scoreTeam1 must be a non-negative number');
      }
      update.score_team1 = scoreTeam1;
    }
    if (scoreTeam2 !== undefined) {
      if (typeof scoreTeam2 !== 'number' || (scoreTeam2 as number) < 0) {
        apiError('scoreTeam2 must be a non-negative number');
      }
      update.score_team2 = scoreTeam2;
    }
    if (notes !== undefined) update.notes = notes;

    if (Object.keys(update).length === 0) apiError('No valid fields to update');

    const { data, error } = await this.supabase.db
      .from('matches')
      .update(update)
      .eq('id', matchId)
      .select()
      .single();

    if (error) apiError(error.message);
    return data;
  }

  async approve(auth: ClerkUser, matchId: string) {
    const { data: match } = await this.supabase.db
      .from('matches')
      .select('*')
      .eq('id', matchId)
      .single();
    if (!match) apiError('Match not found', HttpStatus.NOT_FOUND);
    if (match.status !== 'pending') apiError('Match is not pending');
    if (match.winning_team !== 1 && match.winning_team !== 2) {
      apiError('Match has no winner set — edit it before approving');
    }

    const admin = await getPlayerByClerkId(this.supabase, auth.userId);

    if (match.tournament_id) {
      const { data: tournament } = await this.supabase.db
        .from('tournaments')
        .select('affects_elo')
        .eq('id', match.tournament_id)
        .single();
      if (tournament && tournament.affects_elo === false) {
        const { data: approved } = await this.supabase.db
          .from('matches')
          .update({
            status: 'approved',
            approved_by: admin?.id,
            approved_at: new Date().toISOString(),
          })
          .eq('id', matchId)
          .select()
          .single();

        return { match: approved, deltas: null, newElos: null };
      }
    }

    const playerIds: string[] = [
      match.team1_player1_id,
      match.team1_player2_id,
      match.team2_player1_id,
      match.team2_player2_id,
    ];

    const { data: semesterRow } = await this.supabase.db
      .from('semesters')
      .select('starting_elo')
      .eq('id', match.semester_id)
      .single();

    const { data: statsRows } = await this.supabase.db
      .from('player_semester_stats')
      .select('player_id, elo, peak_elo, placement_matches_played, wins, losses')
      .eq('semester_id', match.semester_id)
      .in('player_id', playerIds);

    const statMap: Record<
      string,
      { elo: number; peak: number; placement: number; wins: number; losses: number }
    > = {};
    const startingElo = semesterRow?.starting_elo ?? DEFAULT_ELO;
    for (const pid of playerIds) {
      const s = statsRows?.find((x) => x.player_id === pid);
      statMap[pid] = {
        elo: s?.elo ?? startingElo,
        peak: s?.peak_elo ?? s?.elo ?? startingElo,
        placement: s?.placement_matches_played ?? 0,
        wins: s?.wins ?? 0,
        losses: s?.losses ?? 0,
      };
    }

    const elosBefore = playerIds.map((pid) => statMap[pid].elo);

    const { deltas, newElos } = calculate2v2(
      [elosBefore[0], elosBefore[1]],
      [elosBefore[2], elosBefore[3]],
      match.winning_team,
      [
        statMap[playerIds[0]].placement,
        statMap[playerIds[1]].placement,
        statMap[playerIds[2]].placement,
        statMap[playerIds[3]].placement,
      ],
    );

    const { error: historyError } = await this.supabase.db.from('elo_history').insert(
      playerIds.map((pid, i) => ({
        player_id:   pid,
        match_id:    matchId,
        season_id:   match.season_id,
        semester_id: match.semester_id,
        elo_before:  elosBefore[i],
        elo_change:  deltas[i],
        elo_after:   newElos[i],
      })),
    );
    if (historyError) {
      apiError(`Failed to record ELO history: ${historyError.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const newPlacements = playerIds.map((pid) =>
      Math.min(statMap[pid].placement + 1, 10),
    );

    await Promise.all(
      playerIds.flatMap((pid, i) => {
        const won = (i < 2 && match.winning_team === 1) || (i >= 2 && match.winning_team === 2);
        const newPeakSemester = Math.max(newElos[i], statMap[pid].peak);
        return [
          // Semester-level stats (source of truth for live ELO)
          this.supabase.db.from('player_semester_stats').upsert(
            {
              player_id:               pid,
              semester_id:             match.semester_id,
              season_id:               match.season_id,
              elo:                     newElos[i],
              peak_elo:                newPeakSemester,
              wins:                    won ? statMap[pid].wins + 1 : statMap[pid].wins,
              losses:                  !won ? statMap[pid].losses + 1 : statMap[pid].losses,
              placement_matches_played: newPlacements[i],
            },
            { onConflict: 'player_id,semester_id' },
          ),
          // Season aggregate (peak ELO across all semesters + total W/L)
          this.supabase.db.rpc('upsert_player_season_aggregate', {
            p_player_id:  pid,
            p_season_id:  match.season_id,
            p_new_elo:    newElos[i],
            p_won:        won,
          }),
          // Cache current ELO on the player row for fast leaderboard queries
          this.supabase.db.from('players').update({ current_elo: newElos[i] }).eq('id', pid),
        ];
      }),
    );

    const { data: approved, error: approveError } = await this.supabase.db
      .from('matches')
      .update({
        status: 'approved',
        approved_by: admin?.id,
        approved_at: new Date().toISOString(),
      })
      .eq('id', matchId)
      .select()
      .single();
    if (approveError) apiError(approveError.message, HttpStatus.INTERNAL_SERVER_ERROR);

    await Promise.all([
      recomputeSemesterRanks(this.supabase.db, match.semester_id),
      autoAwardBadges(this.supabase.db, {
        matchId,
        playerIds,
        newElos,
        placementCounts: newPlacements,
      }),
    ]);

    return { match: approved, deltas, newElos };
  }

  async dispute(matchId: string, notes?: string) {
    const { data, error } = await this.supabase.db
      .from('matches')
      .update({ status: 'disputed', notes })
      .eq('id', matchId)
      .select()
      .single();

    if (error || !data) apiError('Match not found', HttpStatus.NOT_FOUND);
    return data;
  }

  async cancel(matchId: string, notes?: string) {
    const { data, error } = await this.supabase.db
      .from('matches')
      .update({ status: 'cancelled', notes })
      .eq('id', matchId)
      .select()
      .single();

    if (error || !data) apiError('Match not found', HttpStatus.NOT_FOUND);
    return data;
  }
}
