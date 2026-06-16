import { Injectable } from '@nestjs/common';
import { ClerkUser } from '../auth/auth.types';
import { apiError } from '../common/api-error';
import { getPlayerByClerkId } from '../common/player.helpers';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class BadgesService {
  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const { data } = await this.supabase.db.from('badges').select('*');
    return data;
  }

  async award(auth: ClerkUser, body: Record<string, unknown>) {
    const { playerId, badgeId } = body;
    const admin = await getPlayerByClerkId(this.supabase, auth.userId);

    const { data, error } = await this.supabase.db
      .from('player_badges')
      .insert({ player_id: playerId, badge_id: badgeId, awarded_by: admin?.id })
      .select()
      .single();

    if (error) apiError(error.message);
    return data;
  }
}
