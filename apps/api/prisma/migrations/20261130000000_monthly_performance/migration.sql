-- Monthly performance: each subject teacher scores every student of a division on 9 skills (0-5) once a month.
CREATE TABLE `monthly_performance` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `academic_year_id` BIGINT UNSIGNED NOT NULL,
  `section_id` BIGINT UNSIGNED NOT NULL,
  `class_subject_id` BIGINT UNSIGNED NOT NULL,
  `month` CHAR(7) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  `scores` JSON NULL,
  `submitted_by` BIGINT UNSIGNED NULL,
  `submitted_at` DATETIME(3) NULL,
  `return_note` VARCHAR(500) NULL,
  `returned_by` BIGINT UNSIGNED NULL,
  `returned_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_by` BIGINT UNSIGNED NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `monthly_performance_section_id_class_subject_id_month_key` (`section_id`, `class_subject_id`, `month`),
  INDEX `monthly_performance_academic_year_id_month_idx` (`academic_year_id`, `month`),
  CONSTRAINT `monthly_performance_section_id_fkey` FOREIGN KEY (`section_id`) REFERENCES `sections` (`id`),
  CONSTRAINT `monthly_performance_class_subject_id_fkey` FOREIGN KEY (`class_subject_id`) REFERENCES `class_subjects` (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
