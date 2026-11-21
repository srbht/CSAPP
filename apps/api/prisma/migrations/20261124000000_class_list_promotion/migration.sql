-- Class list workflow: prepared (Headmaster / office / operator), confirmed by the class teacher.
ALTER TABLE `sections`
  ADD COLUMN `list_status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT' AFTER `status`,
  ADD COLUMN `list_ready_by` BIGINT UNSIGNED NULL AFTER `list_status`,
  ADD COLUMN `list_ready_at` DATETIME(3) NULL AFTER `list_ready_by`,
  ADD COLUMN `list_confirmed_by` BIGINT UNSIGNED NULL AFTER `list_ready_at`,
  ADD COLUMN `list_confirmed_at` DATETIME(3) NULL AFTER `list_confirmed_by`,
  ADD COLUMN `list_note` VARCHAR(300) NULL AFTER `list_confirmed_at`,
  ADD CONSTRAINT `chk_sections_list_status` CHECK (`list_status` IN ('DRAFT', 'READY', 'CONFIRMED'));

-- Exam Nos are generated per class (medium + standard) once every division's list is confirmed.
ALTER TABLE `classes` ADD COLUMN `exam_nos_at` DATETIME(3) NULL AFTER `status`;

-- Classes that already have exam numbers (from before this workflow) count as generated and confirmed.
UPDATE `classes` c SET c.`exam_nos_at` = NOW(3)
WHERE EXISTS (SELECT 1 FROM `student_enrollments` e WHERE e.`class_id` = c.`id` AND e.`exam_no` IS NOT NULL);
UPDATE `sections` s JOIN `classes` c ON c.`id` = s.`class_id` SET s.`list_status` = 'CONFIRMED', s.`list_confirmed_at` = NOW(3)
WHERE c.`exam_nos_at` IS NOT NULL;

-- Old per-medium exam number series (E1001 / H1001) are replaced by EX001-style series per class.
DELETE FROM `number_sequences` WHERE `seq_key` LIKE 'exam\_no:%';

-- A student promoted into Std I or Std V waits for a new GR No (printed as TEMP).
ALTER TABLE `students` ADD COLUMN `gr_no_temp` TINYINT(1) NOT NULL DEFAULT 0 AFTER `gr_no`;

CREATE TABLE `promotion_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `school_id` BIGINT UNSIGNED NOT NULL,
  `from_section_id` BIGINT UNSIGNED NOT NULL,
  `to_section_id` BIGINT UNSIGNED NULL,
  `detain_section_id` BIGINT UNSIGNED NULL,
  `items` JSON NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  `requested_by` BIGINT UNSIGNED NOT NULL,
  `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `decided_by` BIGINT UNSIGNED NULL,
  `decided_at` DATETIME(3) NULL,
  `note` VARCHAR(300) NULL,
  `result` JSON NULL,
  PRIMARY KEY (`id`),
  INDEX `promotion_requests_school_id_status_idx` (`school_id`, `status`),
  INDEX `promotion_requests_from_section_id_status_idx` (`from_section_id`, `status`),
  CONSTRAINT `promotion_requests_from_section_id_fkey` FOREIGN KEY (`from_section_id`) REFERENCES `sections` (`id`),
  CONSTRAINT `chk_promotion_requests_status` CHECK (`status` IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
