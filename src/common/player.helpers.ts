import { SupabaseService } from '../supabase/supabase.service';

export async function getPlayerByClerkId(supabase: SupabaseService, clerkUserId: string) {
  const { data } = await supabase.db
    .from('players')
    .select('*')
    .eq('clerk_user_id', clerkUserId)
    .single();
  return data;
}

/** @deprecated Use getActiveSemester. Seasons are now year-level containers. */
export async function getActiveSeason(supabase: SupabaseService) {
  const { data } = await supabase.db
    .from('seasons')
    .select('id, name, starting_elo')
    .eq('is_active', true)
    .single();
  return data;
}

/** Returns the active semester with its parent season embedded. */
export async function getActiveSemester(supabase: SupabaseService) {
  const { data } = await supabase.db
    .from('semesters')
    .select('id, name, semester_type, starting_elo, season_id, season:seasons(id, name, starting_elo)')
    .eq('is_active', true)
    .single();
  return data as {
    id: string;
    name: string;
    semester_type: string;
    starting_elo: number;
    season_id: string;
    season: { id: string; name: string; starting_elo: number };
  } | null;
}
