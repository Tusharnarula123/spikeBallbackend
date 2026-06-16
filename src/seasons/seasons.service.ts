import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { DEFAULT_ELO } from '../common/config';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class SeasonsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const { data, error } = await this.supabase.db
      .from('seasons')
      .select('*')
      .order('start_date', { ascending: false });
    if (error) apiError(error.message);
    return data;
  }

  async create(body: Record<string, unknown>) {
    const { name, startDate, endDate, startingElo } = body;

    const { data, error } = await this.supabase.db
      .from('seasons')
      .insert({
        name,
        start_date: startDate,
        end_date: endDate,
        starting_elo: startingElo ?? DEFAULT_ELO,
        is_active: false,
      })
      .select()
      .single();

    if (error) apiError(error.message);
    return data;
  }

  async getActive() {
    const { data, error } = await this.supabase.db
      .from('seasons')
      .select('*')
      .eq('is_active', true)
      .single();
    if (error) apiError('No active season', HttpStatus.NOT_FOUND);
    return data;
  }

  async activate(id: string) {
    await this.supabase.db
      .from('seasons')
      .update({ is_active: false })
      .eq('is_active', true);

    const { data, error } = await this.supabase.db
      .from('seasons')
      .update({ is_active: true })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) apiError('Season not found', HttpStatus.NOT_FOUND);
    return data;
  }
}
