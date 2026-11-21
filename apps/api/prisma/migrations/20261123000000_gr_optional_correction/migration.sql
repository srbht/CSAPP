-- The GR No may stay empty: given after confirmation by the office or the Headmaster.
ALTER TABLE `students` MODIFY `gr_no` VARCHAR(30) NULL;
-- Provisional admissions held their Student ID in place of the GR No: clear it.
UPDATE `students` SET `gr_no` = NULL WHERE `gr_no` = `student_code`;

-- The Headmaster can send a provisional admission back to the office for correction (with a note).
ALTER TABLE `students`
  ADD COLUMN `correction_note` VARCHAR(500) NULL AFTER `status`,
  ADD COLUMN `correction_requested_at` DATETIME(3) NULL AFTER `correction_note`;
