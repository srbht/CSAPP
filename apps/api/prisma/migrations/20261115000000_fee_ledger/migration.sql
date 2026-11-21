-- DropForeignKey
ALTER TABLE `fee_allocations` DROP FOREIGN KEY `fee_allocations_payment_id_fkey`;

-- DropForeignKey
ALTER TABLE `fee_allocations` DROP FOREIGN KEY `fee_allocations_student_fee_id_fkey`;

-- DropForeignKey
ALTER TABLE `fee_heads` DROP FOREIGN KEY `fee_heads_school_id_fkey`;

-- DropForeignKey
ALTER TABLE `fee_plan_items` DROP FOREIGN KEY `fee_plan_items_class_id_fkey`;

-- DropForeignKey
ALTER TABLE `fee_plan_items` DROP FOREIGN KEY `fee_plan_items_fee_head_id_fkey`;

-- DropForeignKey
ALTER TABLE `student_fees` DROP FOREIGN KEY `student_fees_enrollment_id_fkey`;

-- DropForeignKey
ALTER TABLE `student_fees` DROP FOREIGN KEY `student_fees_fee_head_id_fkey`;

-- DropForeignKey
ALTER TABLE `student_fees` DROP FOREIGN KEY `student_fees_plan_item_id_fkey`;

-- AlterTable
ALTER TABLE `fee_payments` ADD COLUMN `concession` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `current_year_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `paid_before` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `previous_outstanding` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `total_payable` DECIMAL(12, 2) NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE `fee_allocations`;

-- DropTable
DROP TABLE `fee_heads`;

-- DropTable
DROP TABLE `fee_plan_items`;

-- DropTable
DROP TABLE `student_fees`;

-- CreateTable
CREATE TABLE `class_fees` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `academic_year_id` BIGINT UNSIGNED NOT NULL,
    `class_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `class_fees_class_id_key`(`class_id`),
    INDEX `class_fees_academic_year_id_idx`(`academic_year_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `student_fee_ledgers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `student_id` BIGINT UNSIGNED NOT NULL,
    `academic_year_id` BIGINT UNSIGNED NOT NULL,
    `enrollment_id` BIGINT UNSIGNED NOT NULL,
    `previous_outstanding` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `opening_reason` VARCHAR(200) NULL,
    `year_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `concession` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `concession_reason` VARCHAR(200) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `student_fee_ledgers_enrollment_id_key`(`enrollment_id`),
    INDEX `student_fee_ledgers_academic_year_id_idx`(`academic_year_id`),
    UNIQUE INDEX `student_fee_ledgers_student_id_academic_year_id_key`(`student_id`, `academic_year_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `class_fees` ADD CONSTRAINT `class_fees_class_id_fkey` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `student_fee_ledgers` ADD CONSTRAINT `student_fee_ledgers_enrollment_id_fkey` FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules the database enforces itself.
ALTER TABLE `class_fees` ADD CONSTRAINT `chk_cf_amount` CHECK (`amount` >= 0);
ALTER TABLE `student_fee_ledgers` ADD CONSTRAINT `chk_sfl_amounts` CHECK (`previous_outstanding` >= 0 AND `year_fee` >= 0 AND `concession` >= 0 AND `concession` <= `year_fee`);
