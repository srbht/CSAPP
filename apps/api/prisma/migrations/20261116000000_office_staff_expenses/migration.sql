-- AlterTable
ALTER TABLE `fee_payments` ADD COLUMN `is_backdated` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `manual_receipt_no` VARCHAR(40) NULL;

-- AlterTable
ALTER TABLE `staff` ADD COLUMN `alt_mobile` CHAR(10) NULL,
    ADD COLUMN `bank_account_holder` VARCHAR(150) NULL,
    ADD COLUMN `bank_account_no` VARCHAR(18) NULL,
    ADD COLUMN `bank_ifsc` CHAR(11) NULL,
    ADD COLUMN `bank_name` VARCHAR(100) NULL,
    ADD COLUMN `blood_group` VARCHAR(5) NULL,
    ADD COLUMN `department` VARCHAR(60) NULL,
    ADD COLUMN `dob` DATE NULL,
    ADD COLUMN `employee_type` VARCHAR(20) NULL,
    ADD COLUMN `father_or_spouse_name` VARCHAR(150) NULL,
    ADD COLUMN `gender` VARCHAR(10) NULL,
    ADD COLUMN `leaving_date` DATE NULL,
    ADD COLUMN `monthly_salary` DECIMAL(12, 2) NULL,
    ADD COLUMN `qualification` VARCHAR(150) NULL,
    ADD COLUMN `remarks` TEXT NULL,
    ADD COLUMN `reporting_manager_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `salary_mode` VARCHAR(20) NULL;

-- CreateTable
CREATE TABLE `staff_documents` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `staff_id` BIGINT UNSIGNED NOT NULL,
    `title` VARCHAR(100) NOT NULL,
    `file_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` BIGINT UNSIGNED NULL,

    INDEX `staff_documents_staff_id_idx`(`staff_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expense_categories` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `school_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `is_salary` BOOLEAN NOT NULL DEFAULT false,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `sort_order` SMALLINT NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `expense_categories_school_id_code_key`(`school_id`, `code`),
    UNIQUE INDEX `expense_categories_school_id_name_key`(`school_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expenses` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `school_id` BIGINT UNSIGNED NOT NULL,
    `voucher_no` VARCHAR(30) NOT NULL,
    `academic_year_id` BIGINT UNSIGNED NULL,
    `expense_date` DATE NOT NULL,
    `category_id` BIGINT UNSIGNED NOT NULL,
    `title` VARCHAR(150) NOT NULL,
    `description` TEXT NOT NULL,
    `paid_to` VARCHAR(150) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `mode` VARCHAR(20) NOT NULL,
    `reference` VARCHAR(80) NULL,
    `bill_no` VARCHAR(60) NULL,
    `remarks` TEXT NULL,
    `staff_id` BIGINT UNSIGNED NULL,
    `salary_month` TINYINT NULL,
    `salary_year` SMALLINT NULL,
    `monthly_salary` DECIMAL(12, 2) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `approved_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(3) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(3) NULL,
    `reject_reason` VARCHAR(300) NULL,
    `cancelled_by` BIGINT UNSIGNED NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancel_reason` VARCHAR(300) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `expenses_school_id_expense_date_idx`(`school_id`, `expense_date`),
    INDEX `expenses_school_id_status_idx`(`school_id`, `status`),
    INDEX `expenses_staff_id_salary_year_salary_month_idx`(`staff_id`, `salary_year`, `salary_month`),
    UNIQUE INDEX `expenses_school_id_voucher_no_key`(`school_id`, `voucher_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expense_attachments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `expense_id` BIGINT UNSIGNED NOT NULL,
    `file_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` BIGINT UNSIGNED NULL,

    INDEX `expense_attachments_expense_id_idx`(`expense_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `fee_payments_school_id_manual_receipt_no_idx` ON `fee_payments`(`school_id`, `manual_receipt_no`);

-- AddForeignKey
ALTER TABLE `staff_documents` ADD CONSTRAINT `staff_documents_staff_id_fkey` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_staff_id_fkey` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expense_attachments` ADD CONSTRAINT `expense_attachments_expense_id_fkey` FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- A manual (physical) receipt number may be used by only ONE valid receipt. Cancelled receipts keep their number
-- for the record, so a corrected receipt can be re-issued against the same physical slip.
ALTER TABLE `fee_payments` ADD COLUMN `manual_receipt_active` VARCHAR(40) GENERATED ALWAYS AS (IF(`status` = 'VALID', `manual_receipt_no`, NULL)) STORED;
CREATE UNIQUE INDEX `fee_payments_school_manual_receipt_active_key` ON `fee_payments`(`school_id`, `manual_receipt_active`);

-- Rules the database enforces itself.
ALTER TABLE `expenses` ADD CONSTRAINT `chk_exp_amount` CHECK (`amount` > 0);
ALTER TABLE `expenses` ADD CONSTRAINT `chk_exp_status` CHECK (`status` IN ('PENDING','APPROVED','REJECTED','CANCELLED'));
ALTER TABLE `staff` ADD CONSTRAINT `chk_staff_status` CHECK (`status` IN ('PENDING_ASSIGNMENT','ACTIVE','INACTIVE','RESIGNED'));
