-- The GR No is no longer generated: the Headmaster enters it for each student (when confirming an admission).
DELETE FROM `number_sequences` WHERE `seq_key` = 'gr_no';
