import type { SupabaseClient } from "@supabase/supabase-js";
import type { AudioStorage } from "../generation/storage";

/**
 * Supabase Storage-backed audio (T041). Objects live in the PRIVATE `lesson-audio`
 * bucket namespaced `<ownerId>/<lessonId>/...`; playback is via short-lived signed
 * URLs minted server-side for the owner only (FR-014, FR-019, Constitution V).
 */
export class SupabaseAudioStorage implements AudioStorage {
  constructor(
    private readonly db: SupabaseClient,
    private readonly bucket: string,
  ) {}

  async upload(
    ownerId: string,
    lessonId: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ storagePath: string }> {
    const ext = mimeType === "audio/mpeg" ? "mp3" : "bin";
    const storagePath = `${ownerId}/${lessonId}/lesson.${ext}`;
    const { error } = await this.db.storage
      .from(this.bucket)
      .upload(storagePath, bytes, { contentType: mimeType, upsert: true });
    if (error) throw new Error(`audio upload: ${error.message}`);
    return { storagePath };
  }

  async signedUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await this.db.storage
      .from(this.bucket)
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error || !data) throw new Error(`signed url: ${error?.message ?? "unknown"}`);
    return data.signedUrl;
  }
}
