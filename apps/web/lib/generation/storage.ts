/**
 * Audio storage boundary (research R5/R7). The Supabase implementation writes to the
 * private `lesson-audio` bucket namespaced as `<ownerId>/<lessonId>/...`; the in-memory
 * implementation lets the generation pipeline be tested without Storage.
 */
export interface AudioStorage {
  upload(
    ownerId: string,
    lessonId: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ storagePath: string }>;
  /** Mint a short-lived signed URL for owner playback (FR-014, FR-019). */
  signedUrl(storagePath: string, expiresInSeconds: number): Promise<string>;
}

export class InMemoryAudioStorage implements AudioStorage {
  private objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  async upload(
    ownerId: string,
    lessonId: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ storagePath: string }> {
    const ext = mimeType === "audio/mpeg" ? "mp3" : "bin";
    const storagePath = `${ownerId}/${lessonId}/lesson.${ext}`;
    this.objects.set(storagePath, { bytes, mimeType });
    return { storagePath };
  }

  async signedUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    return `memory://${storagePath}?expires=${expiresInSeconds}`;
  }
}
