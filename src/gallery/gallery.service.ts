import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { apiError } from '../common/api-error';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class GalleryService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: this.config.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key:    this.config.get<string>('CLOUDINARY_API_KEY'),
      api_secret: this.config.get<string>('CLOUDINARY_API_SECRET'),
    });
  }

  async list() {
    const { data, error } = await this.supabase.db
      .from('gallery_images')
      .select('*')
      .order('display_order', { ascending: true });
    if (error) apiError(error.message);
    return data ?? [];
  }

  async upload(fileBuffer: Buffer, originalName: string, altText: string) {
    // Upload to Cloudinary
    const result = await new Promise<{ secure_url: string; public_id: string }>(
      (resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            { folder: 'ou-roundnet-gallery', resource_type: 'image' },
            (err, res) => {
              if (err || !res) return reject(err ?? new Error('Upload failed'));
              resolve({ secure_url: res.secure_url, public_id: res.public_id });
            },
          )
          .end(fileBuffer);
      },
    );

    // Get current max order
    const { data: existing } = await this.supabase.db
      .from('gallery_images')
      .select('display_order')
      .order('display_order', { ascending: false })
      .limit(1);
    const nextOrder = existing && existing.length > 0 ? existing[0].display_order + 1 : 0;

    // Save URL to DB
    const { data, error } = await this.supabase.db
      .from('gallery_images')
      .insert({
        url: result.secure_url,
        public_id: result.public_id,
        alt_text: altText || originalName,
        display_order: nextOrder,
      })
      .select()
      .single();

    if (error) apiError(error.message);
    return data;
  }

  async remove(id: string) {
    // Get the public_id first
    const { data: image } = await this.supabase.db
      .from('gallery_images')
      .select('public_id')
      .eq('id', id)
      .single();

    if (image?.public_id) {
      await cloudinary.uploader.destroy(image.public_id);
    }

    const { error } = await this.supabase.db
      .from('gallery_images')
      .delete()
      .eq('id', id);

    if (error) apiError(error.message);
    return { deleted: true };
  }
}
