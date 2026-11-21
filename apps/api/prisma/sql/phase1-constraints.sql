-- ---------------------------------------------------------------------------
-- Integrity rules Prisma cannot model (see prisma/README.md before generating
-- new migrations: never let a generated migration drop ux_*/chk_* objects).
-- ---------------------------------------------------------------------------
ALTER TABLE `academic_years` ADD CONSTRAINT `chk_ay_dates` CHECK (`end_date` > `start_date`);
ALTER TABLE `academic_terms` ADD CONSTRAINT `chk_term_dates` CHECK (`end_date` >= `start_date`);
ALTER TABLE `grade_bands` ADD CONSTRAINT `chk_band_range` CHECK (`min_percent` <= `max_percent` AND `min_percent` >= 0 AND `max_percent` <= 100);
ALTER TABLE `class_subjects` ADD CONSTRAINT `chk_cs_marks` CHECK (`default_pass_marks` IS NULL OR `default_max_marks` IS NULL OR `default_pass_marks` <= `default_max_marks`);
ALTER TABLE `teaching_assignments` ADD CONSTRAINT `chk_ta_subject` CHECK (`role` <> 'SUBJECT_TEACHER' OR `class_subject_id` IS NOT NULL);
ALTER TABLE `teaching_assignments` ADD CONSTRAINT `chk_ta_role` CHECK (`role` IN ('OPERATOR','SUBJECT_TEACHER','CLASS_TEACHER','ATTENDANCE_VERIFIER'));

-- At most one current academic year per school.
CREATE UNIQUE INDEX `ux_ay_one_current` ON `academic_years` ((CASE WHEN `is_current` = 1 THEN `school_id` END));
-- At most one active class teacher per division.
CREATE UNIQUE INDEX `ux_ta_one_class_teacher` ON `teaching_assignments` ((CASE WHEN `role` = 'CLASS_TEACHER' AND `status` = 'ACTIVE' THEN `section_id` END));
-- No duplicate active assignment of the same teacher to the same division/subject/role.
CREATE UNIQUE INDEX `ux_ta_active` ON `teaching_assignments` ((CASE WHEN `status` = 'ACTIVE' THEN CONCAT_WS(':', `staff_id`, `role`, `section_id`, IFNULL(`class_subject_id`, 0)) END));
