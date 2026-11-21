-- Admission form extras: PEN, identification marks, health, emergency contact, siblings, BPL/minority, bank account.
ALTER TABLE `students` ADD COLUMN `pen` VARCHAR(20) NULL,
    ADD COLUMN `identification_marks` VARCHAR(200) NULL,
    ADD COLUMN `height_cm` SMALLINT UNSIGNED NULL,
    ADD COLUMN `weight_kg` DECIMAL(5, 1) NULL,
    ADD COLUMN `medical_notes` VARCHAR(500) NULL,
    ADD COLUMN `emergency_name` VARCHAR(120) NULL,
    ADD COLUMN `emergency_relation` VARCHAR(40) NULL,
    ADD COLUMN `emergency_mobile` CHAR(10) NULL,
    ADD COLUMN `siblings_in_school` VARCHAR(300) NULL,
    ADD COLUMN `is_bpl` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `is_minority` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `bank_account_no` VARCHAR(18) NULL,
    ADD COLUMN `bank_ifsc` CHAR(11) NULL,
    ADD COLUMN `bank_name` VARCHAR(100) NULL;

-- CreateTable
CREATE TABLE `student_documents` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `student_id` BIGINT UNSIGNED NOT NULL,
    `doc_type` VARCHAR(60) NOT NULL,
    `file_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` BIGINT UNSIGNED NULL,

    INDEX `student_documents_student_id_doc_type_idx`(`student_id`, `doc_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `student_documents` ADD CONSTRAINT `student_documents_student_id_fkey` FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
