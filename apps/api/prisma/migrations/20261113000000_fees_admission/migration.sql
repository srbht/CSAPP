-- AlterTable
ALTER TABLE `students` ADD COLUMN `cwsn` VARCHAR(60) NULL,
    ADD COLUMN `documents` JSON NULL,
    ADD COLUMN `is_rte` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `nationality` VARCHAR(40) NULL DEFAULT 'Indian',
    ADD COLUMN `previous_class` VARCHAR(20) NULL,
    ADD COLUMN `previous_lc_date` DATE NULL,
    ADD COLUMN `previous_lc_no` VARCHAR(40) NULL,
    ADD COLUMN `sub_caste` VARCHAR(80) NULL,
    ADD COLUMN `transport_mode` VARCHAR(30) NULL;

-- AlterTable
ALTER TABLE `guardians` ADD COLUMN `annual_income` VARCHAR(40) NULL,
    ADD COLUMN `education` VARCHAR(60) NULL,
    ADD COLUMN `whatsapp` CHAR(10) NULL;

-- CreateTable
CREATE TABLE `fee_heads` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `school_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `name_hi` VARCHAR(80) NULL,
    `frequency` VARCHAR(20) NOT NULL,
    `waived_for_rte` BOOLEAN NOT NULL DEFAULT true,
    `sort_order` SMALLINT NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `fee_heads_school_id_code_key`(`school_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fee_plan_items` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `academic_year_id` BIGINT UNSIGNED NOT NULL,
    `class_id` BIGINT UNSIGNED NOT NULL,
    `fee_head_id` BIGINT UNSIGNED NOT NULL,
    `label` VARCHAR(60) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `due_date` DATE NOT NULL,
    `sequence` SMALLINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,

    INDEX `fee_plan_items_academic_year_id_idx`(`academic_year_id`),
    UNIQUE INDEX `fee_plan_items_class_id_fee_head_id_label_key`(`class_id`, `fee_head_id`, `label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `student_fees` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `enrollment_id` BIGINT UNSIGNED NOT NULL,
    `plan_item_id` BIGINT UNSIGNED NULL,
    `fee_head_id` BIGINT UNSIGNED NOT NULL,
    `label` VARCHAR(60) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `concession` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `concession_reason` VARCHAR(200) NULL,
    `due_date` DATE NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `student_fees_enrollment_id_due_date_idx`(`enrollment_id`, `due_date`),
    UNIQUE INDEX `student_fees_enrollment_id_plan_item_id_key`(`enrollment_id`, `plan_item_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fee_payments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `school_id` BIGINT UNSIGNED NOT NULL,
    `academic_year_id` BIGINT UNSIGNED NOT NULL,
    `enrollment_id` BIGINT UNSIGNED NOT NULL,
    `receipt_no` VARCHAR(30) NOT NULL,
    `paid_on` DATE NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `mode` VARCHAR(20) NOT NULL,
    `reference` VARCHAR(60) NULL,
    `payer_name` VARCHAR(150) NULL,
    `remarks` VARCHAR(300) NULL,
    `balance_after` DECIMAL(12, 2) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'VALID',
    `cancel_reason` VARCHAR(300) NULL,
    `cancelled_by` BIGINT UNSIGNED NULL,
    `cancelled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` BIGINT UNSIGNED NOT NULL,

    INDEX `fee_payments_academic_year_id_paid_on_idx`(`academic_year_id`, `paid_on`),
    INDEX `fee_payments_enrollment_id_idx`(`enrollment_id`),
    UNIQUE INDEX `fee_payments_school_id_receipt_no_key`(`school_id`, `receipt_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fee_allocations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `payment_id` BIGINT UNSIGNED NOT NULL,
    `student_fee_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,

    INDEX `fee_allocations_student_fee_id_idx`(`student_fee_id`),
    UNIQUE INDEX `fee_allocations_payment_id_student_fee_id_key`(`payment_id`, `student_fee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `fee_heads` ADD CONSTRAINT `fee_heads_school_id_fkey` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fee_plan_items` ADD CONSTRAINT `fee_plan_items_class_id_fkey` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fee_plan_items` ADD CONSTRAINT `fee_plan_items_fee_head_id_fkey` FOREIGN KEY (`fee_head_id`) REFERENCES `fee_heads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_fees` ADD CONSTRAINT `student_fees_enrollment_id_fkey` FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_fees` ADD CONSTRAINT `student_fees_plan_item_id_fkey` FOREIGN KEY (`plan_item_id`) REFERENCES `fee_plan_items`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `student_fees` ADD CONSTRAINT `student_fees_fee_head_id_fkey` FOREIGN KEY (`fee_head_id`) REFERENCES `fee_heads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fee_payments` ADD CONSTRAINT `fee_payments_school_id_fkey` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fee_payments` ADD CONSTRAINT `fee_payments_enrollment_id_fkey` FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fee_allocations` ADD CONSTRAINT `fee_allocations_payment_id_fkey` FOREIGN KEY (`payment_id`) REFERENCES `fee_payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fee_allocations` ADD CONSTRAINT `fee_allocations_student_fee_id_fkey` FOREIGN KEY (`student_fee_id`) REFERENCES `student_fees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------
-- Fee integrity rules (keep in sync with packages/shared/src/fees.ts). Never drop in later migrations.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE `fee_heads` ADD CONSTRAINT `chk_fh_freq` CHECK (`frequency` IN ('ONE_TIME','ANNUAL','TERM','MONTHLY'));
ALTER TABLE `fee_plan_items` ADD CONSTRAINT `chk_fpi_amount` CHECK (`amount` > 0);
ALTER TABLE `student_fees`
  ADD CONSTRAINT `chk_sf_amount` CHECK (`amount` > 0 AND `concession` >= 0 AND `concession` <= `amount`),
  ADD CONSTRAINT `chk_sf_status` CHECK (`status` IN ('ACTIVE','CANCELLED'));
ALTER TABLE `fee_payments`
  ADD CONSTRAINT `chk_fp_amount` CHECK (`amount` > 0 AND `balance_after` >= 0),
  ADD CONSTRAINT `chk_fp_mode` CHECK (`mode` IN ('CASH','UPI','CHEQUE','BANK_TRANSFER','CARD','DD')),
  ADD CONSTRAINT `chk_fp_status` CHECK (`status` IN ('VALID','CANCELLED'));
ALTER TABLE `fee_allocations` ADD CONSTRAINT `chk_fa_amount` CHECK (`amount` > 0);
