-- Greensheet: part-wise marks (OBS, Oral, … Written) and the Headmaster's result decisions.
ALTER TABLE `exam_subjects` ADD COLUMN `parts` JSON NULL;
ALTER TABLE `marks` ADD COLUMN `parts` JSON NULL;

CREATE TABLE `greensheets` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `section_id` BIGINT UNSIGNED NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `approved_by` BIGINT UNSIGNED NULL,
    `approved_by_name` VARCHAR(150) NULL,
    `approved_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` BIGINT UNSIGNED NULL,
    UNIQUE INDEX `greensheets_section_id_key`(`section_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `greensheets_status_check` CHECK (`status` IN ('DRAFT', 'APPROVED')),
    CONSTRAINT `greensheets_section_id_fkey` FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `greensheet_results` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `enrollment_id` BIGINT UNSIGNED NOT NULL,
    `result` VARCHAR(20) NULL,
    `grace` JSON NULL,
    `remark` VARCHAR(200) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` BIGINT UNSIGNED NULL,
    UNIQUE INDEX `greensheet_results_enrollment_id_key`(`enrollment_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `greensheet_results_result_check` CHECK (`result` IS NULL OR `result` IN ('PASS', 'PROMOTED', 'RE_EXAM', 'DETAINED')),
    CONSTRAINT `greensheet_results_enrollment_id_fkey` FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Class IX–X Science and activity subjects have no Formative part (max1 = 0) but always a Summative part.
ALTER TABLE `exam_subjects` DROP CHECK `chk_es_max`;
ALTER TABLE `exam_subjects`
  ADD CONSTRAINT `chk_es_max` CHECK (`max1` >= 0 AND (`max2` IS NULL OR `max2` > 0) AND (`max1` > 0 OR `max2` IS NOT NULL));
