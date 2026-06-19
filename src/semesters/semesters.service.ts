import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { DEFAULT_ELO } from '../common/config';
import { SupabaseService } from '../supabase/supabase.service';

// Semester date ranges within a season year.
// Season runs May 1 (yearStart) → Apr 30 (yearEnd).
function semesterDates(yearStart: number) {
  return {
    summer: { start: `${yearStart}-05-01`,     end: `${yearStart}-08-31` },
    fall:   { start: `${yearStart}-09-01`,     end: `${yearStart}-12-31` },
    spring: { start: `${yearStart + 1}-01-01`, end: `${yearStart + 1}-04-30` },
  };
}

@Injectable()
export class SemestersService {
  constructor(private readonly supabase: SupabaseService) {}

  // ── Seasons ──────────────────────────────────────────────────────────────

  async listSeasons() {
    const { data, error } = await this.supabase.db
      .from('seasons')
      .select('*, semesters(*)')
      .order('year_start', { ascending: false });
    if (error) apiError(error.message);
    return data;
  }

  /**
   * Create a season and auto-generate its 3 semesters.
   * yearStart = e.g. 2025  →  season "2025-2026", semesters Summer/Fall/Spring.
   */
  async createSeason(body: { yearStart: number; startingElo?: number }) {
    const { yearStart, startingElo = DEFAULT_ELO } = body;
    if (!yearStart || yearStart < 2020) apiError('yearStart must be a valid year (≥ 2020)');

    const yearEnd = yearStart + 1;
    const name    = `${yearStart}-${yearEnd}`;
    const dates   = semesterDates(yearStart);

    // Insert season
    const { data: season, error: sErr } = await this.supabase.db
      .from('seasons')
      .insert({
        name,
        start_date:  dates.summer.start,
        end_date:    dates.spring.end,
        year_start:  yearStart,
        year_end:    yearEnd,
        starting_elo: startingElo,
        is_active:   false,
      })
      .select()
      .single();
    if (sErr) apiError(sErr.code === '23505' ? `Season ${name} already exists` : sErr.message);

    // Auto-create 3 semesters
    const semRows = (
      ['summer', 'fall', 'spring'] as const
    ).map((type) => ({
      season_id:     season.id,
      name:          `${type.charAt(0).toUpperCase() + type.slice(1)} ${type === 'spring' ? yearEnd : yearStart}`,
      semester_type: type,
      start_date:    dates[type].start,
      end_date:      dates[type].end,
      starting_elo:  startingElo,
      is_active:     false,
    }));

    const { data: semesters, error: semErr } = await this.supabase.db
      .from('semesters')
      .insert(semRows)
      .select();
    if (semErr) apiError(semErr.message);

    return { season, semesters };
  }

  // ── Semesters ─────────────────────────────────────────────────────────────

  async listSemesters(seasonId?: string) {
    let q = this.supabase.db
      .from('semesters')
      .select('*, season:seasons(id, name, year_start, year_end)')
      .order('start_date', { ascending: true });
    if (seasonId) q = q.eq('season_id', seasonId);
    const { data, error } = await q;
    if (error) apiError(error.message);
    return data;
  }

  async getActiveSemester() {
    const { data, error } = await this.supabase.db
      .from('semesters')
      .select('*, season:seasons(id, name, year_start, year_end, starting_elo)')
      .eq('is_active', true)
      .single();
    if (error || !data) apiError('No active semester', HttpStatus.NOT_FOUND);
    return data;
  }

  /**
   * Activate a semester. Deactivates the previous one first.
   * Also marks the parent season as active and deactivates other seasons.
   */
  async activateSemester(semesterId: string) {
    // Deactivate all semesters
    await this.supabase.db
      .from('semesters')
      .update({ is_active: false })
      .eq('is_active', true);

    // Activate the requested semester
    const { data: semester, error } = await this.supabase.db
      .from('semesters')
      .update({ is_active: true })
      .eq('id', semesterId)
      .select('*, season:seasons(id)')
      .single();
    if (error || !semester) apiError('Semester not found', HttpStatus.NOT_FOUND);

    // Keep seasons.is_active in sync for backward-compat queries
    await this.supabase.db.from('seasons').update({ is_active: false }).eq('is_active', true);
    await this.supabase.db
      .from('seasons')
      .update({ is_active: true })
      .eq('id', (semester.season as { id: string }).id);

    return semester;
  }

  /**
   * Delete a season (and its semesters), as long as it's not active and has
   * no matches recorded against it — those constraints keep ELO history and
   * match records from being silently orphaned.
   */
  async deleteSeason(id: string) {
    const { data: season, error: seasonErr } = await this.supabase.db
      .from('seasons')
      .select('id, name, is_active')
      .eq('id', id)
      .maybeSingle();
    if (seasonErr) apiError(seasonErr.message);
    if (!season) apiError('Season not found', HttpStatus.NOT_FOUND);

    if (season.is_active) {
      apiError('Cannot delete the active season — activate a different semester first');
    }

    const { count, error: matchErr } = await this.supabase.db
      .from('matches')
      .select('id', { count: 'exact', head: true })
      .eq('season_id', id);
    if (matchErr) apiError(matchErr.message);
    if (count && count > 0) {
      apiError(`Cannot delete "${season.name}" — it has ${count} recorded match${count === 1 ? '' : 'es'}`);
    }

    const { error: semErr } = await this.supabase.db.from('semesters').delete().eq('season_id', id);
    if (semErr) apiError(semErr.message);

    const { error: delErr } = await this.supabase.db.from('seasons').delete().eq('id', id);
    if (delErr) apiError(delErr.message);

    return { success: true };
  }

  async updateSemester(id: string, body: Record<string, unknown>) {
    const allowed = ['name', 'startDate', 'endDate', 'startingElo'] as const;
    const fieldMap: Record<string, string> = {
      startDate:   'start_date',
      endDate:     'end_date',
      startingElo: 'starting_elo',
    };
    const update: Record<string, unknown> = {};
    for (const key of allowed) {
      if (body[key] !== undefined) update[fieldMap[key] ?? key] = body[key];
    }
    if (Object.keys(update).length === 0) apiError('No valid fields to update');

    const { data, error } = await this.supabase.db
      .from('semesters')
      .update(update)
      .eq('id', id)
      .select()
      .single();
    if (error) apiError(error.message);
    return data;
  }
}
