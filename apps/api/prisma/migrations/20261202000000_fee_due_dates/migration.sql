-- Fee due dates: each date has a minimum amount (for all classes); fee_instalment_amounts now holds only a class's own amount
-- where it differs. The annual class fee is no longer derived from these amounts.
ALTER TABLE `fee_instalments` ADD COLUMN `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0 AFTER `due_date`;
