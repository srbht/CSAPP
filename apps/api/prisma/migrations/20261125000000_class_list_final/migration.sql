-- Class list: after the class teacher confirms, the Headmaster finalizes; then Exam Nos are generated with a button.
ALTER TABLE `sections` DROP CHECK `chk_sections_list_status`;
ALTER TABLE `sections`
  ADD COLUMN `list_final_by` BIGINT UNSIGNED NULL AFTER `list_confirmed_at`,
  ADD COLUMN `list_final_at` DATETIME(3) NULL AFTER `list_final_by`,
  ADD CONSTRAINT `chk_sections_list_status` CHECK (`list_status` IN ('DRAFT', 'READY', 'CONFIRMED', 'FINAL'));
-- Divisions whose class already has Exam Nos are final.
UPDATE `sections` s JOIN `classes` c ON c.`id` = s.`class_id` SET s.`list_status` = 'FINAL', s.`list_final_at` = NOW(3)
WHERE c.`exam_nos_at` IS NOT NULL;
