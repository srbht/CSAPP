-- Admission form number, generated when a new admission is entered (e.g. AF-2026-00001).
ALTER TABLE `students` ADD COLUMN `admission_form_no` VARCHAR(30) NULL AFTER `student_code`;
CREATE UNIQUE INDEX `students_school_id_admission_form_no_key` ON `students`(`school_id`, `admission_form_no`);

INSERT INTO `number_sequences` (`school_id`, `seq_key`, `label`, `pattern`, `next_value`, `created_at`, `updated_at`)
SELECT s.`id`, 'admission_form', 'Admission form number', 'AF-{YEAR}-{00000}', 1, NOW(3), NOW(3)
FROM `schools` s
WHERE NOT EXISTS (SELECT 1 FROM `number_sequences` n WHERE n.`school_id` = s.`id` AND n.`seq_key` = 'admission_form');
