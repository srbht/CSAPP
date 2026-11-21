-- CreateTable
CREATE TABLE `students` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `school_id` BIGINT UNSIGNED NOT NULL,
    `student_code` VARCHAR(20) NOT NULL,
    `gr_no` VARCHAR(30) NOT NULL,
    `school_uid` VARCHAR(40) NULL,
    `saral_id` VARCHAR(30) NULL,
    `apaar_id` VARCHAR(20) NULL,
    `full_name` VARCHAR(250) NOT NULL,
    `full_name_hi` VARCHAR(250) NULL,
    `surname` VARCHAR(80) NULL,
    `first_name` VARCHAR(80) NULL,
    `father_name` VARCHAR(120) NULL,
    `mother_name` VARCHAR(120) NULL,
    `gender` VARCHAR(10) NOT NULL,
    `dob` DATE NULL,
    `birth_place` VARCHAR(100) NULL,
    `mother_tongue` VARCHAR(40) NULL,
    `blood_group` VARCHAR(5) NULL,
    `religion` VARCHAR(40) NULL,
    `category` VARCHAR(30) NULL,
    `caste` VARCHAR(80) NULL,
    `aadhaar_last4` CHAR(4) NULL,
    `address_line` VARCHAR(300) NULL,
    `city` VARCHAR(80) NULL,
    `pincode` CHAR(6) NULL,
    `admission_date` DATE NULL,
    `previous_school` VARCHAR(200) NULL,
    `photo_file_id` BIGINT UNSIGNED NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `students_school_id_full_name_idx`(`school_id`, `full_name`),
    INDEX `students_school_id_school_uid_idx`(`school_id`, `school_uid`),
    UNIQUE INDEX `students_school_id_student_code_key`(`school_id`, `student_code`),
    UNIQUE INDEX `students_school_id_gr_no_key`(`school_id`, `gr_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `guardians` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `school_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `name_hi` VARCHAR(150) NULL,
    `mobile` CHAR(10) NULL,
    `alt_mobile` CHAR(10) NULL,
    `email` VARCHAR(150) NULL,
    `occupation` VARCHAR(100) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `guardians_school_id_mobile_idx`(`school_id`, `mobile`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `student_guardians` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `student_id` BIGINT UNSIGNED NOT NULL,
    `guardian_id` BIGINT UNSIGNED NOT NULL,
    `relation` VARCHAR(20) NOT NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `student_guardians_guardian_id_idx`(`guardian_id`),
    UNIQUE INDEX `student_guardians_student_id_guardian_id_key`(`student_id`, `guardian_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `student_enrollments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `student_id` BIGINT UNSIGNED NOT NULL,
    `academic_year_id` BIGINT UNSIGNED NOT NULL,
    `class_id` BIGINT UNSIGNED NOT NULL,
    `section_id` BIGINT UNSIGNED NOT NULL,
    `medium_id` BIGINT UNSIGNED NOT NULL,
    `roll_no` SMALLINT UNSIGNED NULL,
    `exam_no` VARCHAR(20) NULL,
    `joined_on` DATE NOT NULL,
    `left_on` DATE NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `final_result` VARCHAR(20) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `student_enrollments_section_id_status_idx`(`section_id`, `status`),
    INDEX `student_enrollments_class_id_status_idx`(`class_id`, `status`),
    INDEX `student_enrollments_academic_year_id_medium_id_status_idx`(`academic_year_id`, `medium_id`, `status`),
    UNIQUE INDEX `student_enrollments_student_id_academic_year_id_key`(`student_id`, `academic_year_id`),
    UNIQUE INDEX `student_enrollments_academic_year_id_exam_no_key`(`academic_year_id`, `exam_no`),
    UNIQUE INDEX `student_enrollments_section_id_roll_no_key`(`section_id`, `roll_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `student_status_history` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `student_id` BIGINT UNSIGNED NOT NULL,
    `from_status` VARCHAR(20) NULL,
    `to_status` VARCHAR(20) NOT NULL,
    `effective_date` DATE NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` BIGINT UNSIGNED NULL,

    INDEX `student_status_history_student_id_created_at_idx`(`student_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `students` ADD CONSTRAINT `students_school_id_fkey` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `guardians` ADD CONSTRAINT `guardians_school_id_fkey` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_guardians` ADD CONSTRAINT `student_guardians_student_id_fkey` FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_guardians` ADD CONSTRAINT `student_guardians_guardian_id_fkey` FOREIGN KEY (`guardian_id`) REFERENCES `guardians`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_enrollments` ADD CONSTRAINT `student_enrollments_student_id_fkey` FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_enrollments` ADD CONSTRAINT `student_enrollments_academic_year_id_fkey` FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_enrollments` ADD CONSTRAINT `student_enrollments_class_id_fkey` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_enrollments` ADD CONSTRAINT `student_enrollments_section_id_fkey` FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_enrollments` ADD CONSTRAINT `student_enrollments_medium_id_fkey` FOREIGN KEY (`medium_id`) REFERENCES `mediums`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_status_history` ADD CONSTRAINT `student_status_history_student_id_fkey` FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------
-- Phase 2 integrity rules (hand-written; keep in sync with packages/shared enums). Never drop in later migrations.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE `students`
  ADD CONSTRAINT `chk_student_gender` CHECK (`gender` IN ('MALE','FEMALE','OTHER')),
  ADD CONSTRAINT `chk_student_status` CHECK (`status` IN ('ACTIVE','WITHDRAWN','TRANSFERRED','PASSED_OUT','INACTIVE')),
  ADD CONSTRAINT `chk_student_aadhaar4` CHECK (`aadhaar_last4` IS NULL OR `aadhaar_last4` REGEXP '^[0-9]{4}$'),
  ADD CONSTRAINT `chk_student_pincode` CHECK (`pincode` IS NULL OR `pincode` REGEXP '^[0-9]{6}$');

ALTER TABLE `student_guardians`
  ADD CONSTRAINT `chk_sg_relation` CHECK (`relation` IN ('FATHER','MOTHER','GUARDIAN','OTHER'));

ALTER TABLE `student_enrollments`
  ADD CONSTRAINT `chk_enr_status` CHECK (`status` IN ('ACTIVE','PROMOTED','DETAINED','COMPLETED','TRANSFERRED_OUT','WITHDRAWN')),
  ADD CONSTRAINT `chk_enr_dates` CHECK (`left_on` IS NULL OR `left_on` >= `joined_on`);
