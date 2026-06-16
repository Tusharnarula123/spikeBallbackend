import { HttpStatus, Injectable } from '@nestjs/common';
import { ClerkUser } from '../auth/auth.types';
import { apiError } from '../common/api-error';
import { getPlayerByClerkId } from '../common/player.helpers';
import { SupabaseService } from '../supabase/supabase.service';

export interface CreateNotificationInput {
  playerId: string;
  type: 'team_assigned' | 'match_submitted' | 'match_approved' | 'general';
  title: string;
  body: string;
  link?: string;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly supabase: SupabaseService) {}

  /** Create one or many notifications (bulk-safe). */
  async create(notifications: CreateNotificationInput | CreateNotificationInput[]) {
    const rows = Array.isArray(notifications) ? notifications : [notifications];

    const inserts = rows.map((n) => ({
      player_id: n.playerId,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link ?? null,
    }));

    const { error } = await this.supabase.db.from('notifications').insert(inserts);
    if (error) {
      // Non-fatal — log but don't surface to callers
      console.error('[NotificationsService] insert error:', error.message);
    }
  }

  /** List notifications for the authenticated player. */
  async list(auth: ClerkUser, opts?: { unreadOnly?: boolean; limit?: number }) {
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    let query = this.supabase.db
      .from('notifications')
      .select('*')
      .eq('player_id', player.id)
      .order('created_at', { ascending: false })
      .limit(opts?.limit ?? 50);

    if (opts?.unreadOnly) query = query.eq('is_read', false);

    const { data, error } = await query;
    if (error) apiError(error.message);
    return data ?? [];
  }

  /** Count unread notifications for the player. */
  async unreadCount(auth: ClerkUser): Promise<number> {
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player) return 0;

    const { count } = await this.supabase.db
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('player_id', player.id)
      .eq('is_read', false);

    return count ?? 0;
  }

  /** Mark a single notification as read. */
  async markRead(auth: ClerkUser, notificationId: string) {
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    const { error } = await this.supabase.db
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notificationId)
      .eq('player_id', player.id); // only own notifications

    if (error) apiError(error.message);
    return { success: true };
  }

  /** Mark all notifications as read for the player. */
  async markAllRead(auth: ClerkUser) {
    const player = await getPlayerByClerkId(this.supabase, auth.userId);
    if (!player) apiError('Player not found', HttpStatus.NOT_FOUND);

    const { error } = await this.supabase.db
      .from('notifications')
      .update({ is_read: true })
      .eq('player_id', player.id)
      .eq('is_read', false);

    if (error) apiError(error.message);
    return { success: true };
  }
}
