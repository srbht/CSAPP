-- New admissions entered by the office wait for the Headmaster: PENDING_APPROVAL, then ACTIVE (or REJECTED, kept on record).
ALTER TABLE `students` DROP CHECK `chk_student_status`;
ALTER TABLE `students` ADD CONSTRAINT `chk_student_status` CHECK (`status` IN ('ACTIVE','WITHDRAWN','TRANSFERRED','PASSED_OUT','INACTIVE','PENDING_APPROVAL','REJECTED'));
ALTER TABLE `student_enrollments` DROP CHECK `chk_enr_status`;
ALTER TABLE `student_enrollments` ADD CONSTRAINT `chk_enr_status` CHECK (`status` IN ('ACTIVE','PROMOTED','DETAINED','COMPLETED','TRANSFERRED_OUT','WITHDRAWN','PENDING_APPROVAL','REJECTED'));
