import { HttpStatus, Injectable } from '@nestjs/common';
import { ClerkService } from '../auth/clerk.service';
import { ClerkUser } from '../auth/auth.types';
import { apiError } from '../common/api-error';
import { DEFAULT_ELO } from '../common/config';
import { getPlayerByClerkId } from '../common/player.helpers';
import { SupabaseService } from '../supabase/supabase.service';

// player_badges has two FKs to players (player_id + awarded_by) — must disambiguate.
const PLAYER_BADGES_EMBED =
  'player_badges!player_id(badge_id, awarded_at, badges(name, icon_name, description))';

@Injectable()
export class PlayersService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly clerk: ClerkService,
  ) {}

  async list(auth: ClerkUser, query: { status?: string; excludeSelf?: string; search?: string }) {
    const status = query.status ?? 'active';
    const excludeSelf = query.excludeSelf === 'true';
    const search = query.search;

    if (status !== 'active' && auth.role !== 'admin') {
      apiError('Forbidden', HttpStatus.FORBIDDEN);
    }

    let q = this.supabase.db
      .from('players')
      .select('id, first_name, last_name, email, age, gender, university, current_elo, status, created_at')
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
    return data;
  }
}
