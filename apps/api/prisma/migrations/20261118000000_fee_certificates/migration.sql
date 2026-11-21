-- Fee certificates ("fee structure letter" given to parents): register of every certificate issued.
CREATE TABLE `fee_certificates` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `school_id` BIGINT UNSIGNED NOT NULL,
    `certificate_no` VARCHAR(30) NOT NULL,
    `student_id` BIGINT UNSIGNED NOT NULL,
    `enrollment_id` BIGINT UNSIGNED NOT NULL,
    `academic_year_id` BIGINT UNSIGNED NOT NULL,
    `student_name` VARCHAR(250) NOT NULL,
    `class_name` VARCHAR(60) NOT NULL,
    `medium_name` VARCHAR(60) NOT NULL,
    `year_name` VARCHAR(20) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `issued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `issued_by` BIGINT UNSIGNED NOT NULL,

    INDEX `fee_certificates_student_id_idx`(`student_id`),
    UNIQUE INDEX `fee_certificates_school_id_certificate_no_key`(`school_id`, `certificate_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
