import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { ClerkUser } from '../auth/auth.types';
import { apiError } from '../common/api-error';
import { getPlayerByClerkId } from '../common/player.helpers';
import { SupabaseService } from '../supabase/supabase.service';

const TRIGGER_TYPES = [
  'elo_threshold',
  'win_streak',
  'match_count',
  'placement_done',
  'manual',
] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];

@Injectable()
export class BadgesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: this.config.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.config.get<string>('CLOUDINARY_API_KEY'),
      api_secret: this.config.get<string>('CLOUDINARY_API_SECRET'),
    });
  }

  async list() {
    const { data, error } = await this.supabase.db
      .from('badges')
      .select('*, tournament:tournaments(id, name)')
      .order('created_at', { ascending: true });
    if (error) apiError(error.message);
    return data;
  }

  /**
   * Create a new badge type. Admin-created badges default to "manual" — i.e.
   * they're only ever awarded by an admin via `award()`, not by the automatic
   * elo/streak/match-count logic in lib/badges.ts.
   *
   * Icon: either a Lucide `iconName` string, or a custom uploaded `icon` image
   * (stored on Cloudinary, URL + public_id saved on the row) — at least one
   * is required. Optionally tied to a `tournamentId` so the badge template
   * itself is scoped to a specific tournament.
   */
  async create(body: Record<string, unknown>, file?: Express.Multer.File) {
    const name = (body.name as string | undefined)?.trim();
    const description = (body.description as string | undefined)?.trim();
    const iconName = (body.iconName as string | undefined)?.trim() || null;
    const tournamentId = (body.tournamentId as string | undefined)?.trim() || null;
    const triggerType = ((body.triggerType as string | undefined)?.trim() || 'manual') as TriggerType;
    const triggerValue = body.triggerValue != null && body.triggerValue !== '' ? Number(body.triggerValue) : null;

    if (!name) apiError('Badge name is required');
    if (!description) apiError('Badge description is required');
    if (!iconName && !file) apiError('Provide an icon name or upload a custom icon image');
    if (!TRIGGER_TYPES.includes(triggerType)) {
      apiError(`triggerType must be one of: ${TRIGGER_TYPES.join(', ')}`);
    }
    if (['elo_threshold', 'win_streak', 'match_count'].includes(triggerType) && !triggerValue) {
      apiError(`A trigger value is required for "${triggerType}" badges`);
    }

    if (tournamentId) {
      const { data: tournament } = await this.supabase.db
        .from('tournaments')
        .select('id')
        .eq('id', tournamentId)
        .maybeSingle();
      if (!tournament) apiError('Tournament not found', HttpStatus.NOT_FOUND);
    }

    let iconUrl: string | null = null;
    let iconPublicId: string | null = null;
    if (file) {
      const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
        cloudinary.uploader
          .upload_stream({ folder: 'ou-roundnet-badges', resource_type: 'image' }, (err, res) => {
            if (err || !res) return reject(err ?? new Error('Upload failed'));
            resolve({ secure_url: res.secure_url, public_id: res.public_id });
          })
          .end(file.buffer);
      });
      iconUrl = result.secure_url;
      iconPublicId = result.public_id;
    }

    const { data, error } = await this.supabase.db
      .from('badges')
      .insert({
        name,
        description,
        icon_name: iconName,
        icon_url: iconUrl,
        icon_public_id: iconPublicId,
        tournament_id: tournamentId,
        trigger_type: triggerType,
        trigger_value: triggerType === 'manual' || triggerType === 'placement_done' ? null : triggerValue,
      })
      .select()
      .single();

    if (error) {
      apiError(error.code === '23505' ? `A badge named "${name}" already exists` : error.message);
    }
    return data;
  }

  /** Delete a badge type, as long as no player currently holds it. Cleans up its Cloudinary icon, if any. */
  async delete(id: string) {
    const { count, error: countErr } = await this.supabase.db
      .from('player_badges')
      .select('id', { count: 'exact', head: true })
      .eq('badge_id', id);
    if (countErr) apiError(countErr.message);
    if (count && count > 0) {
      apiError(`Cannot delete — ${count} player${count === 1 ? '' : 's'} already earned this badge`);
    }

    const { data: badge } = await this.supabase.db
      .from('badges')
      .select('icon_public_id')
      .eq('id', id)
      .maybeSingle();

    const { error } = await this.supabase.db.from('badges').delete().eq('id', id);
    if (error) apiError(error.message);

    if (badge?.icon_public_id) {
      await cloudinary.uploader.destroy(badge.icon_public_id);
    }

    return { success: true };
  }

  /**
   * Manually award a badge to a player, optionally scoped to a tournament so
   * players can later see which tournament they earned it in.
   */
  async award(auth: ClerkUser, body: Record<string, unknown>) {
    const playerId = body.playerId as string | undefined;
    const badgeId = body.badgeId as string | undefined;
    const tournamentId = (body.tournamentId as string | undefined) || null;

    if (!playerId) apiError('playerId is required');
    if (!badgeId) apiError('badgeId is required');

    const admin = await getPlayerByClerkId(this.supabase, auth.userId);

    const { data: player } = await this.supabase.db
      .from('players')
      .select('id')
      .eq('id', playerId)
      .maybeSingle();
    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    const { data: badge } = await this.supabase.db
      .from('badges')
      .select('id')
      .eq('id', badgeId)
      .maybeSingle();
    if (!badge) apiError('Badge not found', HttpStatus.NOT_FOUND);

    if (tournamentId) {
      const { data: tournament } = await this.supabase.db
        .from('tournaments')
        .select('id')
        .eq('id', tournamentId)
        .maybeSingle();
      if (!tournament) apiError('Tournament not found', HttpStatus.NOT_FOUND);
    }

    // Friendly duplicate check — NULL tournament_id values aren't reliably
    // deduped by the DB's unique constraint, so we check explicitly here too.
    let dupQuery = this.supabase.db
      .from('player_badges')
      .select('id', { count: 'exact', head: true })
      .eq('player_id', playerId)
      .eq('badge_id', badgeId);
    dupQuery = tournamentId ? dupQuery.eq('tournament_id', tournamentId) : dupQuery.is('tournament_id', null);
    const { count: dupCount } = await dupQuery;
    if (dupCount && dupCount > 0) {
      apiError(
        tournamentId
          ? 'This player already has this badge for that tournament'
          : 'This player already has this badge',
      );
    }

    const { data, error } = await this.supabase.db
      .from('player_badges')
      .insert({
        player_id: playerId,
        badge_id: badgeId,
        tournament_id: tournamentId,
        awarded_by: admin?.id ?? null,
      })
      .select()
      .single();

    if (error) {
      apiError(error.code === '23505' ? 'This player already has this badge' : error.message);
    }
    return data;
  }
}
