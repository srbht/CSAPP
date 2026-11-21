-- Mark sheets in two steps: the Unit Test (OBT) column is sent and approved first, then locked.
ALTER TABLE `academic_submissions` ADD COLUMN `locked_parts` JSON NULL;
