-- Fee instalments: the Headmaster sets, per academic year, the instalments (due dates) and each class's amount per instalment.
-- Late-fee penalties are charged per student and instalment; a penalty can be removed (waived) with a reason.
CREATE TABLE `fee_instalments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `academic_year_id` BIGINT UNSIGNED NOT NULL,
  `seq` INT UNSIGNED NOT NULL,
  `label` VARCHAR(40) NOT NULL,
  `due_date` DATE NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_by` BIGINT UNSIGNED NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `fee_instalments_academic_year_id_seq_key` (`academic_year_id`, `seq`),
  CONSTRAINT `fee_instalments_academic_year_id_fkey` FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years` (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `fee_instalment_amounts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instalment_id` BIGINT UNSIGNED NOT NULL,
  `class_id` BIGINT UNSIGNED NOT NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `fee_instalment_amounts_instalment_id_class_id_key` (`instalment_id`, `class_id`),
  INDEX `fee_instalment_amounts_class_id_idx` (`class_id`),
  CONSTRAINT `fee_instalment_amounts_instalment_id_fkey` FOREIGN KEY (`instalment_id`) REFERENCES `fee_instalments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fee_instalment_amounts_class_id_fkey` FOREIGN KEY (`class_id`) REFERENCES `classes` (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `fee_penalties` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ledger_id` BIGINT UNSIGNED NOT NULL,
  `instalment_id` BIGINT UNSIGNED NOT NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  `waive_reason` VARCHAR(300) NULL,
  `waived_by` BIGINT UNSIGNED NULL,
  `waived_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_by` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `fee_penalties_ledger_id_instalment_id_key` (`ledger_id`, `instalment_id`),
  INDEX `fee_penalties_instalment_id_idx` (`instalment_id`),
  CONSTRAINT `fee_penalties_ledger_id_fkey` FOREIGN KEY (`ledger_id`) REFERENCES `student_fee_ledgers` (`id`),
  CONSTRAINT `fee_penalties_instalment_id_fkey` FOREIGN KEY (`instalment_id`) REFERENCES `fee_instalments` (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Sum of the student's active late fees for the year (kept with the ledger, like the concession).
ALTER TABLE `student_fee_ledgers` ADD COLUMN `penalty` DECIMAL(12, 2) NOT NULL DEFAULT 0 AFTER `concession_reason`;
-- The late fee as it stood on the receipt.
ALTER TABLE `fee_payments` ADD COLUMN `penalty` DECIMAL(12, 2) NOT NULL DEFAULT 0 AFTER `concession`;
