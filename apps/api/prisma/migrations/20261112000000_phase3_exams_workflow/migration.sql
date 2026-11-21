-- CreateTable
CREATE TABLE `exams` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `academic_year_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name_en` VARCHAR(80) NOT NULL,
    `name_hi` VARCHAR(80) NULL,
    `kind` VARCHAR(20) NOT NULL,
    `report_term` VARCHAR(10) NULL,
    `sequence` TINYINT NOT NULL,
    `marks_due_date` DATE NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `exams_academic_year_id_code_key`(`academic_year_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exam_subjects` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `exam_id` BIGINT UNSIGNED NOT NULL,
    `class_subject_id` BIGINT UNSIGNED NOT NULL,
    `max1` DECIMAL(6, 2) NOT NULL,
    `max2` DECIMAL(6, 2) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `exam_subjects_exam_id_class_subject_id_key`(`exam_id`, `class_subject_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `academic_submissions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `academic_year_id` BIGINT UNSIGNED NOT NULL,
    `section_id` BIGINT UNSIGNED NOT NULL,
    `record_type` VARCHAR(20) NOT NULL,
    `exam_id` BIGINT UNSIGNED NULL,
    `class_subject_id` BIGINT UNSIGNED NULL,
    `period` CHAR(7) NULL,
    `unit_key` VARCHAR(80) NOT NULL,
    `stage` VARCHAR(30) NOT NULL DEFAULT 'OPERATOR',
    `status` VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    `revision` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `working_days` DECIMAL(4, 1) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `submitted_at` DATETIME(3) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `academic_submissions_unit_key_key`(`unit_key`),
    INDEX `academic_submissions_academic_year_id_record_type_stage_idx`(`academic_year_id`, `record_type`, `stage`),
    INDEX `academic_submissions_section_id_record_type_idx`(`section_id`, `record_type`),
    INDEX `academic_submissions_exam_id_idx`(`exam_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `marks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `submission_id` BIGINT UNSIGNED NOT NULL,
    `enrollment_id` BIGINT UNSIGNED NOT NULL,
    `exam_id` BIGINT UNSIGNED NOT NULL,
    `class_subject_id` BIGINT UNSIGNED NOT NULL,
    `marks1` DECIMAL(6, 2) NULL,
    `marks2` DECIMAL(6, 2) NULL,
    `absent` BOOLEAN NOT NULL DEFAULT false,
    `row_status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `passed_stage` VARCHAR(30) NOT NULL DEFAULT 'OPERATOR',
    `verified_hash` CHAR(64) NULL,
    `reject_reason` VARCHAR(300) NULL,
    `rejected_stage` VARCHAR(30) NULL,
    `updated_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `marks_enrollment_id_idx`(`enrollment_id`),
    UNIQUE INDEX `marks_submission_id_enrollment_id_key`(`submission_id`, `enrollment_id`),
    UNIQUE INDEX `marks_exam_id_class_subject_id_enrollment_id_key`(`exam_id`, `class_subject_id`, `enrollment_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_monthly` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `submission_id` BIGINT UNSIGNED NOT NULL,
    `enrollment_id` BIGINT UNSIGNED NOT NULL,
    `period` CHAR(7) NOT NULL,
    `present_days` DECIMAL(4, 1) NULL,
    `row_status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `passed_stage` VARCHAR(30) NOT NULL DEFAULT 'OPERATOR',
    `verified_hash` CHAR(64) NULL,
    `reject_reason` VARCHAR(300) NULL,
    `rejected_stage` VARCHAR(30) NULL,
    `updated_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `attendance_monthly_submission_id_enrollment_id_key`(`submission_id`, `enrollment_id`),
    UNIQUE INDEX `attendance_monthly_enrollment_id_period_key`(`enrollment_id`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verification_actions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `submission_id` BIGINT UNSIGNED NOT NULL,
    `revision` INTEGER UNSIGNED NOT NULL,
    `stage` VARCHAR(30) NOT NULL,
    `action` VARCHAR(20) NOT NULL,
    `actor_user_id` BIGINT UNSIGNED NOT NULL,
    `actor_name` VARCHAR(150) NULL,
    `from_status` VARCHAR(30) NULL,
    `to_status` VARCHAR(30) NULL,
    `row_count` INTEGER NULL,
    `enrollment_ids` JSON NULL,
    `comment` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `verification_actions_submission_id_created_at_idx`(`submission_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `student_remarks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `enrollment_id` BIGINT UNSIGNED NOT NULL,
    `term` VARCHAR(10) NOT NULL,
    `progress` VARCHAR(60) NULL,
    `conduct` VARCHAR(60) NULL,
    `remark` VARCHAR(300) NULL,
    `updated_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `student_remarks_enrollment_id_term_key`(`enrollment_id`, `term`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `report_cards` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `enrollment_id` BIGINT UNSIGNED NOT NULL,
    `term` VARCHAR(10) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'GENERATED',
    `snapshot` JSON NOT NULL,
    `generated_by` BIGINT UNSIGNED NOT NULL,
    `generated_at` DATETIME(3) NOT NULL,
    `published_by` BIGINT UNSIGNED NULL,
    `published_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `report_cards_enrollment_id_term_key`(`enrollment_id`, `term`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `exams` ADD CONSTRAINT `exams_academic_year_id_fkey` FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `exam_subjects` ADD CONSTRAINT `exam_subjects_exam_id_fkey` FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `exam_subjects` ADD CONSTRAINT `exam_subjects_class_subject_id_fkey` FOREIGN KEY (`class_subject_id`) REFERENCES `class_subjects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `academic_submissions` ADD CONSTRAINT `academic_submissions_section_id_fkey` FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `academic_submissions` ADD CONSTRAINT `academic_submissions_exam_id_fkey` FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `academic_submissions` ADD CONSTRAINT `academic_submissions_class_subject_id_fkey` FOREIGN KEY (`class_subject_id`) REFERENCES `class_subjects`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `marks` ADD CONSTRAINT `marks_submission_id_fkey` FOREIGN KEY (`submission_id`) REFERENCES `academic_submissions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `marks` ADD CONSTRAINT `marks_enrollment_id_fkey` FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `marks` ADD CONSTRAINT `marks_exam_id_fkey` FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `marks` ADD CONSTRAINT `marks_class_subject_id_fkey` FOREIGN KEY (`class_subject_id`) REFERENCES `class_subjects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_monthly` ADD CONSTRAINT `attendance_monthly_submission_id_fkey` FOREIGN KEY (`submission_id`) REFERENCES `academic_submissions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_monthly` ADD CONSTRAINT `attendance_monthly_enrollment_id_fkey` FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verification_actions` ADD CONSTRAINT `verification_actions_submission_id_fkey` FOREIGN KEY (`submission_id`) REFERENCES `academic_submissions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_remarks` ADD CONSTRAINT `student_remarks_enrollment_id_fkey` FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `report_cards` ADD CONSTRAINT `report_cards_enrollment_id_fkey` FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------
-- Phase 3 integrity rules (hand-written; keep in sync with packages/shared/src/workflow.ts). Never drop.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE `exams`
  ADD CONSTRAINT `chk_exam_kind` CHECK (`kind` IN ('UNIT_TEST','SEMESTER')),
  ADD CONSTRAINT `chk_exam_term` CHECK (`report_term` IS NULL OR `report_term` IN ('TERM1','TERM2'));

ALTER TABLE `exam_subjects`
  ADD CONSTRAINT `chk_es_max` CHECK (`max1` > 0 AND (`max2` IS NULL OR `max2` > 0));

ALTER TABLE `academic_submissions`
  ADD CONSTRAINT `chk_sub_type` CHECK (`record_type` IN ('MARKS','ATTENDANCE')),
  ADD CONSTRAINT `chk_sub_stage` CHECK (`stage` IN ('OPERATOR','SUBJECT_VERIFY','CLASS_APPROVE','HEADMASTER_APPROVE','DONE')),
  ADD CONSTRAINT `chk_sub_status` CHECK (`status` IN ('DRAFT','SUBMITTED','CORRECTION_REQUIRED','APPROVED')),
  ADD CONSTRAINT `chk_sub_shape` CHECK (
    (`record_type` = 'MARKS' AND `exam_id` IS NOT NULL AND `class_subject_id` IS NOT NULL AND `period` IS NULL) OR
    (`record_type` = 'ATTENDANCE' AND `exam_id` IS NULL AND `class_subject_id` IS NULL AND `period` IS NOT NULL));

ALTER TABLE `marks`
  ADD CONSTRAINT `chk_mark_row` CHECK (`row_status` IN ('PENDING','VERIFIED','REJECTED')),
  ADD CONSTRAINT `chk_mark_stage` CHECK (`passed_stage` IN ('OPERATOR','SUBJECT_VERIFY','CLASS_APPROVE','HEADMASTER_APPROVE')),
  ADD CONSTRAINT `chk_mark_values` CHECK ((`marks1` IS NULL OR `marks1` >= 0) AND (`marks2` IS NULL OR `marks2` >= 0));

ALTER TABLE `attendance_monthly`
  ADD CONSTRAINT `chk_att_row` CHECK (`row_status` IN ('PENDING','VERIFIED','REJECTED')),
  ADD CONSTRAINT `chk_att_stage` CHECK (`passed_stage` IN ('OPERATOR','SUBJECT_VERIFY','CLASS_APPROVE','HEADMASTER_APPROVE')),
  ADD CONSTRAINT `chk_att_present` CHECK (`present_days` IS NULL OR `present_days` >= 0);

ALTER TABLE `student_remarks`
  ADD CONSTRAINT `chk_remark_term` CHECK (`term` IN ('TERM1','FINAL'));

ALTER TABLE `report_cards`
  ADD CONSTRAINT `chk_rc_term` CHECK (`term` IN ('TERM1','FINAL')),
  ADD CONSTRAINT `chk_rc_status` CHECK (`status` IN ('GENERATED','PUBLISHED'));
