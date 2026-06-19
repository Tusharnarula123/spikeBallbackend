import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { SupabaseService } from '../supabase/supabase.service';

export interface AboutStat {
  value: string;
  label: string;
}

export interface AboutContent {
  eyebrow: string;
  heading: string;
  paragraphs: string[];
  stats: AboutStat[];
}

// Mirrors the hardcoded content that used to live directly in app/page.tsx —
// served whenever the about_content table hasn't been migrated yet or is empty.
const DEFAULT_ABOUT: AboutContent = {
  eyebrow: 'Who We Are',
  heading: 'About Us',
  paragraphs: [
    'The Oakland University Roundnet Club was founded in 2020 by a group of students passionate about the sport of roundnet (Spikeball).',
    'We are a student-run club officially recognized by Oakland University Campus Recreation, operating under OU Student Organizations.',
    'We compete in local and regional tournaments and are affiliated with USA Roundnet, the national governing body for the sport.',
    'Beginner or experienced — everyone is welcome. We run structured competitive sessions with live ELO rankings alongside open casual play.',
  ],
  stats: [
    { value: '2020', label: 'Founded' },
    { value: '40+', label: 'Members' },
    { value: '3', label: 'Seasons' },
    { value: '200+', label: 'Matches Played' },
  ],
};

@Injectable()
export class AboutService {
  constructor(private readonly supabase: SupabaseService) {}

  async get(): Promise<AboutContent> {
    const { data, error } = await this.supabase.db
      .from('about_content')
      .select('eyebrow, heading, paragraphs, stats')
      .eq('id', 1)
      .maybeSingle();

    // about_content may not be migrated yet — fall back to static defaults.
    if (error) {
      const missing = error.message.includes('about_content') || error.code === 'PGRST205';
      if (missing) return DEFAULT_ABOUT;
      apiError(error.message);
    }

    if (!data) return DEFAULT_ABOUT;

    return {
      eyebrow: data.eyebrow || DEFAULT_ABOUT.eyebrow,
      heading: data.heading || DEFAULT_ABOUT.heading,
      paragraphs:
        Array.isArray(data.paragraphs) && data.paragraphs.length > 0
          ? data.paragraphs
          : DEFAULT_ABOUT.paragraphs,
      stats:
        Array.isArray(data.stats) && data.stats.length > 0 ? data.stats : DEFAULT_ABOUT.stats,
    };
  }

  async update(body: Record<string, unknown>): Promise<AboutContent> {
    const eyebrow = typeof body.eyebrow === 'string' ? body.eyebrow.trim() : undefined;
    const heading = typeof body.heading === 'string' ? body.heading.trim() : undefined;

    const paragraphs = Array.isArray(body.paragraphs)
      ? body.paragraphs
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim())
          .filter(Boolean)
      : undefined;

    const stats = Array.isArray(body.stats)
      ? body.stats
          .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
          .map((s) => ({
            value: String(s.value ?? '').trim(),
            label: String(s.label ?? '').trim(),
          }))
          .filter((s) => s.value && s.label)
      : undefined;

    if (eyebrow === '') apiError('Eyebrow cannot be empty');
    if (heading === '') apiError('Heading cannot be empty');
    if (paragraphs !== undefined && paragraphs.length === 0) apiError('At least one paragraph is required');
    if (stats !== undefined && stats.length === 0) apiError('At least one stat is required');

    if (
      eyebrow === undefined &&
      heading === undefined &&
      paragraphs === undefined &&
      stats === undefined
    ) {
      apiError('Nothing to update');
    }

    const updates: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
    if (eyebrow !== undefined) updates.eyebrow = eyebrow;
    if (heading !== undefined) updates.heading = heading;
    if (paragraphs !== undefined) updates.paragraphs = paragraphs;
    if (stats !== undefined) updates.stats = stats;

    const { data, error } = await this.supabase.db
      .from('about_content')
      .upsert(updates, { onConflict: 'id' })
      .select('eyebrow, heading, paragraphs, stats')
      .single();

    if (error) {
      const missing = error.message.includes('about_content') || error.code === 'PGRST205';
      if (missing) {
        apiError(
          'about_content table not found — run add_about_content_table.sql in the Supabase SQL editor first.',
        );
      }
      apiError(error.message);
    }

    return data as AboutContent;
  }
}
