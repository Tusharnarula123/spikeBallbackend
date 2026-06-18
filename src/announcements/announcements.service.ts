import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { SupabaseService } from '../supabase/supabase.service';

export type AnnouncementType = 'tournament' | 'update' | 'event' | 'general';

export interface Announcement {
  id: string;
  type: AnnouncementType;
  title: string;
  body: string;
  date: string;
}

const STATIC_ANNOUNCEMENTS: Announcement[] = [
  {
    id: 'static-elo',
    type: 'update',
    title: '🆕 ELO System Live',
    body: 'K-factor is 60 for placement matches (first 5) and 24 after. Check the ELO guide on your dashboard for the full breakdown.',
    date: '2025-02-15',
  },
  {
    id: 'static-welcome',
    type: 'general',
    title: '👋 Welcome New Members!',
    body: 'Complete your 5 placement matches to appear on the official leaderboard.',
    date: '2025-01-20',
  },
];

@Injectable()
export class AnnouncementsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const { data: tournaments, error } = await this.supabase.db
      .from('tournaments')
      .select('*')
      .in('status', ['upcoming', 'registration_open', 'in_progress'])
      .order('start_date', { ascending: true });

    // tournaments table lives in database/tournaments_schema.sql — may not be migrated yet
    if (error) {
      const missing =
        error.message.includes("public.tournaments") ||
        error.code === 'PGRST205';
      if (missing) {
        return [...STATIC_ANNOUNCEMENTS].sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        );
      }
      apiError(error.message);
    }

    const tournamentAnnouncements: Announcement[] = (tournaments ?? []).map((t) => {
      let title: string;
      if (t.status === 'registration_open') title = `🏆 ${t.name} — Registration Open`;
      else if (t.status === 'in_progress') title = `🔥 ${t.name} — Live Now`;
      else title = `📅 Upcoming: ${t.name}`;

      const dateStr = new Date(t.start_date).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });

      const bodyParts = [
        t.description ?? '',
        `Date: ${dateStr}.`,
        t.is_casual
          ? 'Casual tournament — results will not affect ELO.'
          : 'Ranked tournament — results affect ELO.',
        t.team_formation === 'self_select'
          ? 'Teams: pick your own teammate when you register.'
          : 'Teams: assigned randomly by an admin.',
        t.status === 'registration_open'
          ? 'Register now from the Register Match page!'
          : '',
      ].filter(Boolean);

      return {
        id: `tournament-${t.id}`,
        type: 'tournament' as const,
        title,
        body: bodyParts.join(' '),
        date: t.start_date,
      };
    });

    return [...tournamentAnnouncements, ...STATIC_ANNOUNCEMENTS].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
  }
}
