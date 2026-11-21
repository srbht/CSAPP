-- Mark sheets: a rejection goes back one step at a time (RETURNED at the step below, which may send it further down or
-- back up). `returned_from` is the step that sent it back.
ALTER TABLE `academic_submissions` DROP CHECK `chk_sub_status`;
ALTER TABLE `academic_submissions`
  ADD COLUMN `returned_from` VARCHAR(30) NULL AFTER `status`,
  ADD CONSTRAINT `chk_sub_status` CHECK (`status` IN ('DRAFT','SUBMITTED','CORRECTION_REQUIRED','APPROVED','RETURNED'));

-- One blank mark sheet per division, subject and semester; the Headmaster corrects it in place (no second sheet).
ALTER TABLE `blank_mark_sheets`
  MODIFY `data` JSON NULL,
  ADD COLUMN `updated_at` DATETIME(3) NULL AFTER `generated_at`,
  ADD COLUMN `updated_by` BIGINT UNSIGNED NULL AFTER `updated_at`;
CREATE UNIQUE INDEX `blank_mark_sheets_exam_id_section_id_class_subject_id_key` ON `blank_mark_sheets`(`exam_id`, `section_id`, `class_subject_id`);
