import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { ClerkService } from '../auth/clerk.service';
import { ClerkUser } from '../auth/auth.types';
import { apiError } from '../common/api-error';
import { DEFAULT_ELO } from '../common/config';
import { getPlayerByClerkId } from '../common/player.helpers';
import { SupabaseService } from '../supabase/supabase.service';

// player_badges has two FKs to players (player_id + awarded_by) — must disambiguate.
// tournament_id is nullable: badges earned outside a specific tournament show no tournament.
const PLAYER_BADGES_EMBED =
  'player_badges!player_id(badge_id, awarded_at, tournament_id, badges(name, icon_name, icon_url, description), tournament:tournaments(id, name))';

@Injectable()
export class PlayersService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly clerk: ClerkService,
    private readonly config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: this.config.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key:    this.config.get<string>('CLOUDINARY_API_KEY'),
      api_secret: this.config.get<string>('CLOUDINARY_API_SECRET'),
    });
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
      .select('id, first_name, last_name, email, age, gender, university, current_elo, status, created_at, avatar_url')
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
    return data;
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
    return data;
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
      if (tournament?.status === 'upcoming' || tournament?.status === 'registration_open') {
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
