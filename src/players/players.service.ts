import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { ClerkService } from '../auth/clerk.service';
import { ClerkUser } from '../auth/auth.types';
import { apiError } from '../common/api-error';
import { DEFAULT_ELO, PLACEMENT_MATCHES_REQUIRED } from '../common/config';
import { getPlayerByClerkId } from '../common/player.helpers';
import { MailService } from '../lib/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SupabaseService } from '../supabase/supabase.service';

// player_badges has two FKs to players (player_id + awarded_by) — must disambiguate.
// tournament_id is nullable: badges earned outside a specific tournament show no tournament.
// `id` is the player_badges row id — admins need it to revoke a single award,
// since a player can hold the same badge for several tournaments.
const PLAYER_BADGES_EMBED =
  'player_badges!player_id(id, badge_id, awarded_at, tournament_id, badges(name, icon_name, icon_url, description), tournament:tournaments(id, name))';

@Injectable()
export class PlayersService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly clerk: ClerkService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly notifs: NotificationsService,
  ) {
    cloudinary.config({
      cloud_name: this.config.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key:    this.config.get<string>('CLOUDINARY_API_KEY'),
      api_secret: this.config.get<string>('CLOUDINARY_API_SECRET'),
    });
  }

  /** Public: search active players by name. Returns minimal public-safe fields. */
  async searchPublic(q?: string) {
    let query = this.supabase.db
      .from('players')
      .select('id, first_name, last_name, avatar_url, current_elo, placement_matches_played')
      .eq('status', 'active')
      .order('first_name', { ascending: true })
      .limit(10);
    if (q) query = query.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) apiError(error.message);
    return data;
  }

  /** Admin-only: return every player regardless of status. */
  async listAll(search?: string) {
    let q = this.supabase.db
      .from('players')
      .select('id, first_name, last_name, email, age, gender, university, current_elo, placement_matches_played, status, created_at, avatar_url')
      .order('first_name', { ascending: true });
    if (search) q = q.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) apiError(error.message);
    return data;
  }

  async list(auth: ClerkUser, query: { status?: string; excludeSelf?: string; search?: string }) {
    const status = query.status ?? 'active';
    const excludeSelf = query.excludeSelf === 'true';
    const search = query.search;

    if (status !== 'active' && auth.role !== 'admin') {
      apiError('Forbidden', HttpStatus.FORBIDDEN);
    }

    let q = this.supabase.db
      .from('players')
      .select('id, first_name, last_name, email, age, gender, university, current_elo, placement_matches_played, status, created_at, avatar_url')
      .order('first_name', { ascending: true });

    if (status !== 'all') q = q.eq('status', status);
    if (search) q = q.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%`);

    if (excludeSelf) {
      const me = await getPlayerByClerkId(this.supabase, auth.userId);
      if (me) q = q.neq('id', me.id);
    }

    const { data, error } = await q;
    if (error) apiError(error.message);
    return data;
  }

  async register(auth: ClerkUser, body: Record<string, unknown>) {
    const { firstName, lastName, email, age, gender } = body;

    if (!firstName || !lastName || !email || !age || !gender) {
      apiError('Missing required fields');
    }

    const existing = await getPlayerByClerkId(this.supabase, auth.userId);
    if (existing) apiError('Player already registered', HttpStatus.CONFLICT);

    const { data, error } = await this.supabase.db
      .from('players')
      .insert({
        clerk_user_id: auth.userId,
        first_name: firstName,
        last_name: lastName,
        email,
        age: Number(age),
        gender,
        status: 'pending',
      })
      .select()
      .single();

    if (error) apiError(error.message);
    return data;
  }

  /** Create a players row from Clerk profile if this user signed up without POST /api/players. */
  private async ensurePlayer(auth: ClerkUser): Promise<void> {
    const existing = await getPlayerByClerkId(this.supabase, auth.userId);
    if (existing) return;

    const client = this.clerk.getClient();
    const clerkUser = await client.users.getUser(auth.userId);

    const { data: created, error } = await this.supabase.db
      .from('players')
      .insert({
        clerk_user_id: auth.userId,
        first_name: clerkUser.firstName || 'Player',
        last_name: clerkUser.lastName ?? '',
        email:
          clerkUser.primaryEmailAddress?.emailAddress ??
          clerkUser.emailAddresses[0]?.emailAddress ??
          `${auth.userId}@unknown.local`,
        status: auth.role === 'admin' ? 'active' : 'pending',
      })
      .select('id')
      .single();

    if (error) {
      apiError(`Could not create player record: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    if (!created) {
      apiError('Could not create player record', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async getMe(auth: ClerkUser) {
    await this.ensurePlayer(auth);

    const { data, error } = await this.supabase.db
      .from('players')
      .select(`*, ${PLAYER_BADGES_EMBED}`)
      .eq('clerk_user_id', auth.userId)
      .maybeSingle();

    if (error) apiError(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    if (!data) apiError('Player not found', HttpStatus.NOT_FOUND);

    // Counted from elo_history rather than the cached stats column, which
    // reads 0 whenever a match was approved against a different semester.
    data.placement_matches_played = await this.placementCount(data.id);

    return data;
  }

  /**
   * Placement matches played, counted from ALL elo_history rows for the player.
   *
   * player_semester_stats.placement_matches_played is a cached counter that
   * drifts to 0 whenever a match was approved against a different semester.
   * elo_history has exactly one row per player per ELO-affecting match, so it
   * is the ground truth — but historical rows carry wrong-or-null
   * semester_id/season_id values from before the wiring was fixed, so ANY
   * semester scoping (equality or "eq-or-null") undercounts and shows 0.
   * Hence: no semester filter at all.
   *
   * ponytail: this is the ceiling of the lazy fix — when a new semester
   * starts, placement is supposed to reset, and an unscoped count never will.
   * Re-tag the historical rows (one UPDATE against elo_history) and then make
   * this semester-scoped again.
   */
  private async placementCount(playerId: string): Promise<number> {
    const { count } = await this.supabase.db
      .from('elo_history')
      .select('id', { count: 'exact', head: true })
      .eq('player_id', playerId);

    return Math.min(count ?? 0, PLACEMENT_MATCHES_REQUIRED);
  }

  async updateMe(auth: ClerkUser, body: Record<string, unknown>) {
    const firstName  = typeof body.firstName  === 'string' ? body.firstName.trim()  : undefined;
    const lastName   = typeof body.lastName   === 'string' ? body.lastName.trim()   : undefined;
    const university = typeof body.university === 'string' ? body.university.trim() : undefined;
    const bio        = typeof body.bio        === 'string' ? body.bio.trim()        : undefined;
    const age        = typeof body.age === 'number' ? body.age : (body.age ? Number(body.age) : undefined);
    const gender     = typeof body.gender === 'string' ? body.gender : undefined;

    const validGenders = ['male', 'female', 'non_binary', 'prefer_not_to_say'];

    if (firstName === '') apiError('First name cannot be empty');
    if (age !== undefined && (isNaN(age) || age < 16 || age > 99)) apiError('Age must be between 16 and 99');
    if (gender !== undefined && !validGenders.includes(gender)) apiError('Invalid gender value');

    const client = this.clerk.getClient();
    const clerkUser = await client.users.getUser(auth.userId);

    await this.ensurePlayer(auth);

    let { data: player } = await this.supabase.db
      .from('players')
      .select('id')
      .eq('clerk_user_id', auth.userId)
      .single();

    if (!player) {
      apiError('Player not found', HttpStatus.NOT_FOUND);
    }

    const updates: Record<string, unknown> = {};
    if (firstName  !== undefined && firstName !== '') updates.first_name = firstName;
    if (lastName   !== undefined) updates.last_name  = lastName;
    if (university !== undefined) updates.university = university || null;
    if (bio        !== undefined) updates.bio        = bio || null;
    if (age        !== undefined && !isNaN(age)) updates.age = age;
    if (gender     !== undefined) updates.gender = gender;

    if (Object.keys(updates).length === 0) apiError('Nothing to update');

    const { data: updated, error: updateError } = await this.supabase.db
      .from('players')
      .update(updates)
      .eq('id', player.id)
      .select()
      .single();

    if (updateError || !updated) {
      apiError(updateError?.message ?? 'Update failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    if (firstName || lastName !== undefined) {
      try {
        await client.users.updateUser(auth.userId, {
          ...(firstName ? { firstName } : {}),
          ...(lastName !== undefined ? { lastName } : {}),
        });
      } catch {
        /* non-fatal */
      }
    }

    return updated;
  }

  async uploadAvatar(auth: ClerkUser, fileBuffer: Buffer) {
    await this.ensurePlayer(auth);

    const { data: player } = await this.supabase.db
      .from('players')
      .select('id, avatar_public_id')
      .eq('clerk_user_id', auth.userId)
      .single();

    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    const result = await new Promise<{ secure_url: string; public_id: string }>(
      (resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            { folder: 'ou-roundnet-avatars', resource_type: 'image' },
            (err, res) => {
              if (err || !res) return reject(err ?? new Error('Upload failed'));
              resolve({ secure_url: res.secure_url, public_id: res.public_id });
            },
          )
          .end(fileBuffer);
      },
    );

    const { data: updated, error: updateError } = await this.supabase.db
      .from('players')
      .update({ avatar_url: result.secure_url, avatar_public_id: result.public_id })
      .eq('id', player.id)
      .select()
      .single();

    if (updateError || !updated) {
      apiError(updateError?.message ?? 'Update failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Best-effort cleanup of the previous avatar asset (non-fatal if it fails)
    if (player.avatar_public_id && player.avatar_public_id !== result.public_id) {
      cloudinary.uploader.destroy(player.avatar_public_id).catch(() => {});
    }

    return updated;
  }

  async removeAvatar(auth: ClerkUser) {
    await this.ensurePlayer(auth);

    const { data: player } = await this.supabase.db
      .from('players')
      .select('id, avatar_public_id')
      .eq('clerk_user_id', auth.userId)
      .single();

    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    const { data: updated, error: updateError } = await this.supabase.db
      .from('players')
      .update({ avatar_url: null, avatar_public_id: null })
      .eq('id', player.id)
      .select()
      .single();

    if (updateError || !updated) {
      apiError(updateError?.message ?? 'Update failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    if (player.avatar_public_id) {
      cloudinary.uploader.destroy(player.avatar_public_id).catch(() => {});
    }

    return updated;
  }

  async getAlltime(auth: ClerkUser) {
    await this.ensurePlayer(auth);
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    // Aggregate from semester-level stats (each semester is a fresh ELO slate)
    const { data, error } = await this.supabase.db
      .from('player_semester_stats')
      .select('wins, losses, elo, peak_elo, semester_id, season_id')
      .eq('player_id', player.id);

    if (error) apiError(error.message);

    const rows = data ?? [];
    const totalWins    = rows.reduce((s, r) => s + (r.wins   ?? 0), 0);
    const totalLosses  = rows.reduce((s, r) => s + (r.losses ?? 0), 0);
    const totalMatches = totalWins + totalLosses;
    const peakElo      = rows.length
      ? Math.max(...rows.map((r) => r.peak_elo ?? r.elo ?? 0))
      : (player.current_elo ?? DEFAULT_ELO);
    // Count distinct seasons (not semesters) as "seasons played"
    const seasonsPlayed = new Set(rows.map((r) => r.season_id)).size;
    const winRate = totalMatches > 0 ? totalWins / totalMatches : 0;

    return { totalWins, totalLosses, totalMatches, peakElo, seasonsPlayed, winRate };
  }

  async getMyEloHistory(auth: ClerkUser, semesterId?: string, seasonId?: string) {
    await this.ensurePlayer(auth);
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    let query = this.supabase.db
      .from('elo_history')
      .select('match_id, elo_before, elo_change, elo_after, recorded_at, season_id, semester_id')
      .eq('player_id', player.id)
      .order('recorded_at', { ascending: true });

    if (semesterId)     query = query.eq('semester_id', semesterId);
    else if (seasonId)  query = query.eq('season_id', seasonId);

    const { data, error } = await query;
    if (error) apiError(error.message);
    return data;
  }

  async getById(id: string) {
    const { data, error } = await this.supabase.db
      .from('players')
      .select(`id, first_name, last_name, gender, current_elo, status, created_at, ${PLAYER_BADGES_EMBED}`)
      .eq('id', id)
      .single();

    if (error || !data) apiError('Player not found', HttpStatus.NOT_FOUND);
    if (data.status !== 'active') apiError('Player not found', HttpStatus.NOT_FOUND);
    return data;
  }

  /**
   * Full public profile for a player — includes stats, peak ELO, and badges.
   * Optionally filtered to a specific season or semester.
   */
  async getPublicProfile(id: string, seasonId?: string, semesterId?: string) {
    const { data: player, error: pErr } = await this.supabase.db
      .from('players')
      .select(`id, first_name, last_name, gender, age, university, bio, avatar_url, current_elo, status, created_at, ${PLAYER_BADGES_EMBED}`)
      .eq('id', id)
      .single();

    if (pErr || !player) apiError('Player not found', HttpStatus.NOT_FOUND);
    if (player.status !== 'active') apiError('Player not found', HttpStatus.NOT_FOUND);

    let wins = 0, losses = 0, currentElo = player.current_elo ?? DEFAULT_ELO, peakElo = player.current_elo ?? DEFAULT_ELO, rank = 0;

    if (semesterId) {
      const [{ data: semStats }, { data: allSem }] = await Promise.all([
        this.supabase.db.from('player_semester_stats').select('wins, losses, elo, peak_elo').eq('player_id', id).eq('semester_id', semesterId).maybeSingle(),
        this.supabase.db.from('player_semester_stats').select('player_id, elo').eq('semester_id', semesterId).order('elo', { ascending: false }),
      ]);
      if (semStats) {
        wins = semStats.wins ?? 0;
        losses = semStats.losses ?? 0;
        currentElo = semStats.elo ?? DEFAULT_ELO;
        peakElo = semStats.peak_elo ?? semStats.elo ?? DEFAULT_ELO;
      }
      rank = ((allSem ?? []).findIndex(s => s.player_id === id) + 1) || 0;
    } else if (seasonId) {
      const { data: seasonStats } = await this.supabase.db
        .from('player_semester_stats').select('wins, losses, elo, peak_elo').eq('player_id', id).eq('season_id', seasonId);
      if (seasonStats && seasonStats.length > 0) {
        wins = seasonStats.reduce((s, r) => s + (r.wins ?? 0), 0);
        losses = seasonStats.reduce((s, r) => s + (r.losses ?? 0), 0);
        peakElo = Math.max(...seasonStats.map(r => r.peak_elo ?? r.elo ?? DEFAULT_ELO));
        currentElo = seasonStats[seasonStats.length - 1]?.elo ?? DEFAULT_ELO;
      }
      const { data: seasonBoard } = await this.supabase.db
        .from('leaderboard_season').select('player_id').eq('season_id', seasonId).order('peak_elo', { ascending: false });
      rank = ((seasonBoard ?? []).findIndex(s => s.player_id === id) + 1) || 0;
    } else {
      const [{ data: activeStats }, { data: allActive }] = await Promise.all([
        this.supabase.db.from('leaderboard_active').select('elo, peak_elo, wins, losses').eq('id', id).maybeSingle(),
        this.supabase.db.from('leaderboard_active').select('id').order('elo', { ascending: false }),
      ]);
      if (activeStats) {
        wins = activeStats.wins ?? 0;
        losses = activeStats.losses ?? 0;
        currentElo = activeStats.elo ?? DEFAULT_ELO;
        peakElo = activeStats.peak_elo ?? activeStats.elo ?? DEFAULT_ELO;
      }
      rank = ((allActive ?? []).findIndex(s => s.id === id) + 1) || 0;
    }

    const placementMatchesPlayed = await this.placementCount(id);

    const totalMatches = wins + losses;
    return {
      id: player.id,
      first_name: player.first_name,
      last_name: player.last_name,
      gender: player.gender,
      age: player.age,
      university: player.university,
      bio: player.bio,
      avatar_url: player.avatar_url,
      current_elo: currentElo,
      peak_elo: peakElo,
      rank: rank || null,
      wins,
      losses,
      total_matches: totalMatches,
      win_rate: totalMatches > 0 ? (wins / totalMatches) * 100 : 0,
      placement_matches_played: placementMatchesPlayed,
      is_ranked: placementMatchesPlayed >= PLACEMENT_MATCHES_REQUIRED,
      member_since: player.created_at,
      badges: player.player_badges,
    };
  }

  /**
   * Match history for a player — with partner/opponent names resolved.
   * Optionally filtered to a specific season or semester.
   */
  async getPlayerMatchHistory(id: string, seasonId?: string, semesterId?: string) {
    const { data: player } = await this.supabase.db.from('players').select('id, status').eq('id', id).single();
    if (!player || player.status !== 'active') apiError('Player not found', HttpStatus.NOT_FOUND);

    let q = this.supabase.db
      .from('matches')
      .select('id, team1_player1_id, team1_player2_id, team1_player3_id, team2_player1_id, team2_player2_id, team2_player3_id, winning_team, score_team1, score_team2, games, status, submitted_at, approved_at, tournament_id, season_id, semester_id, tournaments(id, name)')
      .or(
        `team1_player1_id.eq.${id},team1_player2_id.eq.${id},team1_player3_id.eq.${id},` +
        `team2_player1_id.eq.${id},team2_player2_id.eq.${id},team2_player3_id.eq.${id}`,
      )
      .in('status', ['approved', 'pending'])
      .not('winning_team', 'is', null)
      .order('submitted_at', { ascending: false });

    if (semesterId) q = q.eq('semester_id', semesterId);
    else if (seasonId) q = q.eq('season_id', seasonId);

    const { data: matches, error } = await q;
    if (error) apiError(error.message);
    if (!matches || matches.length === 0) return [];

    // Batch-fetch all referenced player names in one query
    const pidSet = new Set<string>();
    for (const m of matches) {
      [m.team1_player1_id, m.team1_player2_id, m.team1_player3_id,
       m.team2_player1_id, m.team2_player2_id, m.team2_player3_id]
        .filter(Boolean).forEach(pid => pidSet.add(pid as string));
    }
    const { data: playerRows } = await this.supabase.db
      .from('players').select('id, first_name, last_name, avatar_url').in('id', [...pidSet]);
    const pMap = new Map<string, { id: string; first_name: string; last_name: string; avatar_url: string | null }>();
    for (const p of playerRows ?? []) pMap.set(p.id, p);

    const gp = (pid: string | null) => (pid && pMap.has(pid) ? pMap.get(pid)! : null);

    return matches.map(m => {
      const t1 = [m.team1_player1_id, m.team1_player2_id, m.team1_player3_id].filter(Boolean);
      const t2 = [m.team2_player1_id, m.team2_player2_id, m.team2_player3_id].filter(Boolean);
      const onTeam1 = t1.includes(id);
      // A rotating session's odd team has two teammates; `partner` stays the
      // first for existing callers, `partners` has them all.
      const partnerIds = (onTeam1 ? t1 : t2).filter(p => p !== id);
      const partnerId = partnerIds[0] ?? null;
      const oppIds = onTeam1 ? t2 : t1;
      const myTeam = onTeam1 ? 1 : 2;
      const won = m.winning_team === myTeam;
      const tournament = (m.tournaments as unknown) as { id: string; name: string } | { id: string; name: string }[] | null;
      const t = Array.isArray(tournament) ? tournament[0] ?? null : tournament;
      return {
        id: m.id,
        date: m.approved_at ?? m.submitted_at,
        status: m.status,
        tournament: t ? { id: t.id, name: t.name } : null,
        partner: gp(partnerId as string | null),
        partners: partnerIds.map(p => gp(p as string)).filter(Boolean),
        opponents: oppIds.map(p => gp(p as string)).filter(Boolean),
        my_team: myTeam,
        winning_team: m.winning_team,
        won,
        score_for: onTeam1 ? m.score_team1 : m.score_team2,
        score_against: onTeam1 ? m.score_team2 : m.score_team1,
        games: m.games,
      };
    });
  }

  /**
   * Head-to-head record between two players across all approved matches
   * where they appeared on opposite teams.
   */
  async getHeadToHead(id: string, otherId: string) {
    const [{ data: p1 }, { data: p2 }] = await Promise.all([
      this.supabase.db.from('players').select('id, first_name, last_name, avatar_url, current_elo, status').eq('id', id).single(),
      this.supabase.db.from('players').select('id, first_name, last_name, avatar_url, current_elo, status').eq('id', otherId).single(),
    ]);
    if (!p1 || p1.status !== 'active') apiError('Player not found', HttpStatus.NOT_FOUND);
    if (!p2 || p2.status !== 'active') apiError('Other player not found', HttpStatus.NOT_FOUND);

    const { data: matches, error } = await this.supabase.db
      .from('matches')
      .select('id, team1_player1_id, team1_player2_id, team2_player1_id, team2_player2_id, winning_team, score_team1, score_team2, games, submitted_at, approved_at, tournaments(id, name)')
      .eq('status', 'approved')
      .not('winning_team', 'is', null)
      .order('approved_at', { ascending: false });

    if (error) apiError(error.message);

    const h2h = (matches ?? []).filter(m => {
      const t1 = [m.team1_player1_id, m.team1_player2_id];
      const t2 = [m.team2_player1_id, m.team2_player2_id];
      return (t1.includes(id) && t2.includes(otherId)) || (t2.includes(id) && t1.includes(otherId));
    });

    let winsById = 0, winsByOther = 0;
    const matchResults = h2h.map(m => {
      const t1 = [m.team1_player1_id, m.team1_player2_id];
      const idOnT1 = t1.includes(id);
      const myTeam = idOnT1 ? 1 : 2;
      const won = m.winning_team === myTeam;
      if (won) winsById++; else winsByOther++;
      const rawT = (m.tournaments as unknown) as { id: string; name: string } | { id: string; name: string }[] | null;
      const t2 = Array.isArray(rawT) ? rawT[0] ?? null : rawT;
      return {
        id: m.id,
        date: m.approved_at ?? m.submitted_at,
        tournament: t2 ? { id: t2.id, name: t2.name } : null,
        winner: won ? 'player' : 'other',
        score_player: idOnT1 ? m.score_team1 : m.score_team2,
        score_against: idOnT1 ? m.score_team2 : m.score_team1,
        games: m.games,
      };
    });

    return {
      player: { id: p1.id, first_name: p1.first_name, last_name: p1.last_name, avatar_url: p1.avatar_url, current_elo: p1.current_elo },
      other: { id: p2.id, first_name: p2.first_name, last_name: p2.last_name, avatar_url: p2.avatar_url, current_elo: p2.current_elo },
      wins: winsById,
      losses: winsByOther,
      total_matches: h2h.length,
      matches: matchResults,
    };
  }

  async getEloHistory(id: string, semesterId?: string, seasonId?: string) {
    let query = this.supabase.db
      .from('elo_history')
      .select('elo_before, elo_change, elo_after, recorded_at, season_id, semester_id')
      .eq('player_id', id)
      .order('recorded_at', { ascending: true });

    if (semesterId)    query = query.eq('semester_id', semesterId);
    else if (seasonId) query = query.eq('season_id', seasonId);

    const { data, error } = await query;
    if (error) apiError(error.message);
    return data;
  }

  async listPending() {
    const { data, error } = await this.supabase.db
      .from('players')
      .select('id, first_name, last_name, email, age, gender, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (error) apiError(error.message);
    return data;
  }

  async approve(id: string) {
    const { data, error } = await this.supabase.db
      .from('players')
      .update({ status: 'active' })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) apiError('Player not found', HttpStatus.NOT_FOUND);

    // Fire-and-forget: a failed welcome email must never fail the approval.
    this.notifyApproved(data).catch((err) =>
      console.error('[PlayersService] approval notification failed:', err),
    );

    return data;
  }

  /** Welcome notification + email sent once a sign-up is approved. */
  private async notifyApproved(player: {
    id: string; first_name: string; email: string | null;
  }) {
    const greeting = `What up Spiker ${player.first_name}, you are ready for some spiking action! Good luck`;

    await this.notifs.create({
      playerId: player.id,
      // ponytail: 'general' avoids a new enum value + DB check-constraint
      // migration. Add a dedicated type if approvals ever need their own icon.
      type: 'general',
      title: "You're approved!",
      body: greeting,
      link: '/dashboard',
    });

    if (!player.email) return;
    await this.mail.sendNotification({
      to: player.email,
      subject: "You're approved — welcome to OU Roundnet!",
      title: "You're in!",
      body: greeting,
      link: '/dashboard',
      linkLabel: 'Open Your Dashboard',
    });
  }

  /**
   * Rejecting a pending sign-up is not the same as suspending an active
   * member — there's nothing worth keeping a record of, so this removes the
   * account entirely instead of marking it 'suspended'. Only ever applies to
   * still-pending players: someone who's already active/suspended has real
   * history attached and must go through suspend() instead, which a brand
   * new sign-up never has.
   */
  async reject(id: string) {
    const { data: player } = await this.supabase.db
      .from('players')
      .select('id, status')
      .eq('id', id)
      .single();
    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);
    if (player.status !== 'pending') {
      apiError('Only a pending sign-up can be rejected — suspend an existing member instead', HttpStatus.BAD_REQUEST);
    }

    // Clear the one non-cascading reference a brand-new sign-up could still
    // be the target of: another pending player picking them as a preferred
    // partner before either was approved.
    await this.supabase.db
      .from('tournament_registrations')
      .update({ preferred_partner_id: null })
      .eq('preferred_partner_id', id);

    const { error } = await this.supabase.db
      .from('players')
      .delete()
      .eq('id', id);
    if (error) apiError(error.message, HttpStatus.INTERNAL_SERVER_ERROR);

    return { success: true, id };
  }

  async suspend(id: string) {
    const { data, error } = await this.supabase.db
      .from('players')
      .update({ status: 'suspended' })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) apiError('Player not found', HttpStatus.NOT_FOUND);

    await this.removeFromTournamentPools(id);

    return data;
  }

  /**
   * Drop a (now-suspended) player out of any tournament they're registered for,
   * as long as that tournament hasn't locked its field yet (still upcoming or
   * registration_open). If a team was already formed, the team is dissolved and
   * the partner is freed back into the unpaired pool rather than left dangling.
   * Tournaments already in_progress/completed/cancelled are left untouched so we
   * never corrupt a generated bracket or match history.
   */
  private async removeFromTournamentPools(playerId: string) {
    const { data: regs, error } = await this.supabase.db
      .from('tournament_registrations')
      .select('id, team_id, tournament:tournaments(status)')
      .eq('player_id', playerId);

    if (error || !regs || regs.length === 0) return;

    const removableIds: string[] = [];
    const teamIdsToDissolve: string[] = [];

    for (const reg of regs as Record<string, unknown>[]) {
      const tournament = reg.tournament as { status: string } | null;
      if (
        tournament?.status === 'upcoming' ||
        tournament?.status === 'registration_open' ||
        tournament?.status === 'registration_closed'
      ) {
        removableIds.push(reg.id as string);
        if (reg.team_id) teamIdsToDissolve.push(reg.team_id as string);
      }
    }

    if (teamIdsToDissolve.length > 0) {
      // Free the partner's registration so they fall back into the unpaired pool.
      await this.supabase.db
        .from('tournament_registrations')
        .update({ team_id: null })
        .in('team_id', teamIdsToDissolve);

      await this.supabase.db.from('tournament_teams').delete().in('id', teamIdsToDissolve);
    }

    if (removableIds.length > 0) {
      await this.supabase.db.from('tournament_registrations').delete().in('id', removableIds);
    }
  }
}
