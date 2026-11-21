-- Fee certificate: also the concession and the fees already paid for that year at the time of issue (kept as issued).
ALTER TABLE `fee_certificates`
  ADD COLUMN `concession` DECIMAL(12,2) NULL AFTER `amount`,
  ADD COLUMN `paid_amount` DECIMAL(12,2) NULL AFTER `concession`;
