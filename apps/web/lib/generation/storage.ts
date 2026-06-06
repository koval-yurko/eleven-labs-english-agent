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

/**
 * Build a Supabase-Storage-safe object key. Auth0 subjects look like `auth0|abc`,
 * and the `|` (plus other characters) is rejected by Storage key validation, so the
 * owner segment is sanitized to `[a-zA-Z0-9_.-]`. The lesson id is a UUID (already safe).
 */
export function audioObjectKey(ownerId: string, lessonId: string, mimeType: string): string {
  const safeOwner = ownerId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const ext = mimeType === "audio/mpeg" ? "mp3" : "bin";
  return `${safeOwner}/${lessonId}/lesson.${ext}`;
}

export class InMemoryAudioStorage implements AudioStorage {
  private objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  async upload(
    ownerId: string,
    lessonId: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ storagePath: string }> {
    const storagePath = audioObjectKey(ownerId, lessonId, mimeType);
    this.objects.set(storagePath, { bytes, mimeType });
    return { storagePath };
  }

  async signedUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    return `memory://${storagePath}?expires=${expiresInSeconds}`;
  }
}
