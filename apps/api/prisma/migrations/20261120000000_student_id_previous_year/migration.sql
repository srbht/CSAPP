-- Year the student attended the previous school (e.g. 2025-26); printed on the admission form.
ALTER TABLE `students` ADD COLUMN `previous_school_year` VARCHAR(9) NULL AFTER `previous_class`;

-- Student ID: 3-letter medium + academic year's first year + 8-digit running number, e.g. ENG202600000001.
-- Existing IDs (STU000001 …) are kept; the next number can be changed in Settings → Number formats.
UPDATE `number_sequences`
SET `pattern` = '{MEDIUM}{YEAR}{00000000}', `next_value` = 1, `label` = 'Student ID (medium + year + number)'
WHERE `seq_key` = 'student_code' AND `pattern` = 'STU{000000}';
