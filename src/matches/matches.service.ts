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

interface GameScore {
  team1: number;
  team2: number;
}

/**
 * Computes the overall winner and score tally from raw per-game scores.
 * A single entry is one game decided on points. A best-of-3 can be 3
 * entries (full 3 games), or just 2 if one team swept both — the 3rd game
 * is moot once a team already has 2 wins, so players don't have to play it.
 * Two entries split 1-1 aren't enough on their own; that needs a 3rd game.
 */
function computeResultFromGames(games: GameScore[]): {
  winningTeam: 1 | 2;
  scoreTeam1: number;
  scoreTeam2: number;
} {
  if (games.length < 1 || games.length > 3) {
    apiError('games must contain 1, 2, or 3 entries');
  }
  for (const g of games) {
    if (typeof g.team1 !== 'number' || g.team1 < 0 || typeof g.team2 !== 'number' || g.team2 < 0) {
      apiError('Each game score must be a non-negative number');
    }
    if (g.team1 === g.team2) {
      apiError('A game cannot end in a tie — one team must have a higher score');
    }
  }

  if (games.length === 1) {
    const [g] = games;
    return {
      winningTeam: g.team1 > g.team2 ? 1 : 2,
      scoreTeam1: g.team1,
      scoreTeam2: g.team2,
    };
  }

  let gamesWon1 = 0;
  let gamesWon2 = 0;
  for (const g of games) {
    if (g.team1 > g.team2) gamesWon1++;
    else gamesWon2++;
  }

  if (games.length === 2 && gamesWon1 === gamesWon2) {
    apiError('A 1-1 split needs a 3rd game to decide the winner');
  }

  return {
    winningTeam: gamesWon1 > gamesWon2 ? 1 : 2,
    scoreTeam1: gamesWon1,
    scoreTeam2: gamesWon2,
  };
}

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
      matchId,
      team1Player1Id,
      team1Player2Id,
      team2Player1Id,
      team2Player2Id,
      winningTeam,
      scoreTeam1,
      scoreTeam2,
      games,
      notes,
      tournamentId,
    } = body;

    // Either a per-game breakdown (1 game, or best-of-3) which determines the
    // winner/score automatically, or the legacy manual winningTeam + optional
    // overall score — kept for any caller that hasn't moved to `games` yet.
    let finalWinningTeam: 1 | 2;
    let finalScoreTeam1: number | undefined;
    let finalScoreTeam2: number | undefined;
    let gamesToStore: GameScore[] | null = null;

    if (games !== undefined) {
      if (!Array.isArray(games)) apiError('games must be an array');
      gamesToStore = games as GameScore[];
      const computed = computeResultFromGames(gamesToStore);
      finalWinningTeam = computed.winningTeam;
      finalScoreTeam1 = computed.scoreTeam1;
      finalScoreTeam2 = computed.scoreTeam2;
    } else {
      if (![1, 2].includes(winningTeam as number)) {
        apiError('winningTeam must be 1 or 2 (or provide a games breakdown)');
      }
      finalWinningTeam = winningTeam as 1 | 2;
      finalScoreTeam1 = scoreTeam1 as number | undefined;
      finalScoreTeam2 = scoreTeam2 as number | undefined;
    }

    let data: Record<string, unknown> | null;
    let playerIds: string[];

    if (matchId) {
      // Tournament matches (bracket / round-robin pool) are pre-scheduled by
      // an admin generating the bracket — that row already carries
      // bracket_round/bracket_slot/rr_pool/rr_round so the bracket & pool
      // table can find it. Submitting a score for one of these must UPDATE
      // that same row rather than insert a fresh, untracked one, otherwise
      // the bracket/standings (which only read scheduled rows) never see it.
      const { data: existing } = await this.supabase.db
        .from('matches')
        .select('*')
        .eq('id', matchId as string)
        .single();
      if (!existing) apiError('Match not found', HttpStatus.NOT_FOUND);
      if (existing.status !== 'pending') {
        apiError('This match has already been decided — ask an admin to edit it');
      }

      playerIds = [
        existing.team1_player1_id,
        existing.team1_player2_id,
        existing.team2_player1_id,
        existing.team2_player2_id,
      ];
      if (!playerIds.includes(player.id)) {
        apiError('You must be one of the players in the match', HttpStatus.FORBIDDEN);
      }

      const { data: updated, error: updateError } = await this.supabase.db
        .from('matches')
        .update({
          winning_team: finalWinningTeam,
          score_team1:  finalScoreTeam1,
          score_team2:  finalScoreTeam2,
          games:        gamesToStore,
          ...(notes !== undefined ? { notes } : {}),
          submitted_by: player.id,
          status:       'pending',
        })
        .eq('id', matchId as string)
        .select()
        .single();
      if (updateError) apiError(updateError.message);
      data = updated;
    } else {
      playerIds = [
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

      const { data: inserted, error } = await this.supabase.db
        .from('matches')
        .insert({
          season_id:        semester!.season_id,
          semester_id:      semester!.id,
          team1_player1_id: team1Player1Id,
          team1_player2_id: team1Player2Id,
          team2_player1_id: team2Player1Id,
          team2_player2_id: team2Player2Id,
          winning_team:     finalWinningTeam,
          score_team1:      finalScoreTeam1,
          score_team2:      finalScoreTeam2,
          games:            gamesToStore,
          notes,
          submitted_by:     player.id,
          status:           'pending',
          tournament_id:    tournamentId ?? null,
        })
        .select()
        .single();

      if (error) apiError(error.message);
      data = inserted;
    }

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
      // Tournament schedules pre-create every match before it's played
      // (status 'pending', no winner yet) — only show ones a player has
      // actually submitted a score for.
      .not('winning_team', 'is', null)
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

        await this.advanceBracketWinner({ ...match, ...approved }, admin?.id ?? null);

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

    await this.advanceBracketWinner({ ...match, ...approved }, admin?.id ?? null);

    return { match: approved, deltas, newElos };
  }

  /**
   * Single-elimination brackets only ever get their Round 1 matches created
   * up front — nothing else generates Round 2+. Call this right after a
   * bracket match is approved: once both matches feeding a slot in the next
   * round are approved, create that next-round match with the two winners.
   * If this round only had one match, it was the final — mark the
   * tournament completed instead of trying to advance further.
   */
  private async advanceBracketWinner(
    match: Record<string, any>,
    adminId: string | null,
  ) {
    if (!match.tournament_id || match.bracket_round === null || match.bracket_round === undefined) {
      return;
    }

    const { data: siblings } = await this.supabase.db
      .from('matches')
      .select('id, status, winning_team, bracket_slot, team1_player1_id, team1_player2_id, team2_player1_id, team2_player2_id')
      .eq('tournament_id', match.tournament_id)
      .eq('bracket_round', match.bracket_round);

    if ((siblings?.length ?? 0) <= 1) {
      // Only one match in this round — it was the final.
      await this.supabase.db
        .from('tournaments')
        .update({ status: 'completed' })
        .eq('id', match.tournament_id)
        .eq('status', 'in_progress');
      return;
    }

    const partnerSlot = match.bracket_slot % 2 === 0 ? match.bracket_slot + 1 : match.bracket_slot - 1;
    const partner = siblings!.find((s) => s.bracket_slot === partnerSlot);
    // Partner hasn't been approved yet (or doesn't exist — a bye) — wait;
    // the partner's own approval will trigger this same check again.
    if (!partner || partner.status !== 'approved' || partner.winning_team == null) return;

    const nextRound = match.bracket_round + 1;
    const nextSlot = Math.floor(match.bracket_slot / 2);

    // Guard against double-creating the next match (e.g. a re-triggered check).
    const { count: existing } = await this.supabase.db
      .from('matches')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', match.tournament_id)
      .eq('bracket_round', nextRound)
      .eq('bracket_slot', nextSlot);
    if ((existing ?? 0) > 0) return;

    const myP1 = match.winning_team === 1 ? match.team1_player1_id : match.team2_player1_id;
    const myP2 = match.winning_team === 1 ? match.team1_player2_id : match.team2_player2_id;
    const partnerP1 = partner.winning_team === 1 ? partner.team1_player1_id : partner.team2_player1_id;
    const partnerP2 = partner.winning_team === 1 ? partner.team1_player2_id : partner.team2_player2_id;

    // Keep the lower slot's winner as "team 1" so bracket ordering stays stable.
    const lowerIsMine = match.bracket_slot < partner.bracket_slot;
    const team1p1 = lowerIsMine ? myP1 : partnerP1;
    const team1p2 = lowerIsMine ? myP2 : partnerP2;
    const team2p1 = lowerIsMine ? partnerP1 : myP1;
    const team2p2 = lowerIsMine ? partnerP2 : myP2;

    await this.supabase.db.from('matches').insert({
      season_id:        match.season_id,
      tournament_id:    match.tournament_id,
      team1_player1_id: team1p1,
      team1_player2_id: team1p2,
      team2_player1_id: team2p1,
      team2_player2_id: team2p2,
      status:           'pending',
      bracket_round:    nextRound,
      bracket_slot:     nextSlot,
      submitted_by:     adminId ?? match.submitted_by,
    });
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
