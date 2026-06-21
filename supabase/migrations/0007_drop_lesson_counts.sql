-- 0007_drop_lesson_counts.sql — drop unused lesson count columns.
--
-- Forward-only cleanup. `requested_item_count` and `skipped_item_count` were written but
-- never read for any product purpose: the user-facing skip list is recomputed from
-- `source_items` (service.ts `skippedFromItems`), and the requested count was carried in the
-- status DTO but never displayed. `accepted_item_count` (rendered on the list + detail pages),
-- `model_id`, and `prompt_version` (reproducibility metadata, Constitution III) are retained.

alter table lessons drop column if exists requested_item_count;
alter table lessons drop column if exists skipped_item_count;
