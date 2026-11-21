import { useQuery } from '@tanstack/react-query';
import {
  classSchema, gradingSystemSchema, PERMISSIONS, REPORT_ROLLUP, sectionSchema, SUBJECT_AREAS, SUBJECT_TYPES, subjectSchema, validateGradeBands,
} from '@cps/shared';
import { ArrowLeft, BookOpen, GraduationCap, ListChecks, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { applyServerErrors, EmptyState, PageHeader, QueryView, Section, StatusBadge, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/overlay';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useGradingSystems, useMediums, useStandards, useWorkingContext } from '@/lib/hooks';
import type { ClassSubject, GradeBand, GradingSystem, SchoolClass, Section as Division, Subject } from '@/lib/types';
import { cn } from '@/lib/utils';
import { err, useZodForm } from './settings';

const P = PERMISSIONS;
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function MediumFilter({ value, onChange }: { value: number | ''; onChange: (v: number | '') => void }) {
  const mediums = useMediums();
  return (
    <Select aria-label="Medium" className="w-44" value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}>
      <option value="">All mediums</option>
      {mediums.data?.map((m) => <option key={m.id} value={m.id}>{m.nameEn}</option>)}
    </Select>
  );
}

export function useClasses(yearId: number | null, mediumId: number | '') {
  return useQuery({
    queryKey: ['classes', yearId, mediumId],
    queryFn: () => api.get<SchoolClass[]>(`/classes${qs({ academicYearId: yearId, mediumId })}`),
    enabled: !!yearId,
  });
}

// ======================================================================= Classes & divisions
export function ClassesPage() {
  const { can } = useAuth();
  const canEdit = can(P.ACADEMICS_MANAGE);
  const ctx = useWorkingContext();
  const [mediumId, setMediumId] = useState<number | ''>(ctx.mediumId ?? '');
  const classes = useClasses(ctx.yearId, mediumId);
  const [classDlg, setClassDlg] = useState<SchoolClass | 'new' | null>(null);
  const [divDlg, setDivDlg] = useState<{ cls: SchoolClass; div?: Division } | null>(null);
  const closed = ctx.year?.status === 'CLOSED';

  return (
    <>
      <PageHeader
        title="Classes & Divisions"
        description={`${ctx.year?.name ?? ''} · each standard is set up separately for each medium`}
        actions={<>
          <MediumFilter value={mediumId} onChange={setMediumId} />
          {canEdit && !closed && <Button onClick={() => setClassDlg('new')}><Plus /> Add class</Button>}
        </>}
      />
      <QueryView query={classes} empty={(d) => (d.length ? null : <Card><EmptyState icon={GraduationCap} title="No classes yet" description="Add a class for each standard in each medium, e.g. English Medium – X." action={canEdit && !closed && <Button onClick={() => setClassDlg('new')}><Plus /> Add class</Button>} /></Card>)}>
        {(list) => (
          <div className="grid gap-4 md:grid-cols-2">
            {list.map((c) => (
              <Card key={c.id} className={cn(c.status !== 'ACTIVE' && 'opacity-70')}>
                <div className="flex items-start gap-3 border-b px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{c.displayName}</h2>
                      <Badge variant="secondary">{c.medium.nameEn}</Badge>
                      {c.status !== 'ACTIVE' && <StatusBadge status={c.status} />}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {c.subjectCount} subjects · {c.gradingSystem?.name ?? 'No grading system'}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" asChild><Link to={`/academics/classes/${c.id}/subjects`}><ListChecks /> Subjects</Link></Button>
                    {canEdit && !closed && <Button size="sm" variant="ghost" onClick={() => setClassDlg(c)} aria-label={`Edit ${c.displayName}`}><Pencil /></Button>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 px-5 py-4">
                  {c.sections.length === 0 && <p className="text-sm text-muted-foreground">No divisions yet.</p>}
                  {c.sections.map((s) => (
                    <button
                      key={s.id}
                      disabled={!canEdit || closed}
                      onClick={() => setDivDlg({ cls: c, div: s })}
                      className="flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors enabled:hover:border-primary/40 disabled:cursor-default"
                    >
                      <span className="grid size-7 place-items-center rounded-md bg-primary/10 font-semibold text-primary">{s.name}</span>
                      <span className="leading-tight">
                        <span className="flex items-center gap-1 text-xs text-muted-foreground"><UserRound className="size-3" />{s.classTeacher?.name ?? 'No class teacher'}</span>
                        <span className="text-xs text-muted-foreground">{s.capacity ? `Capacity ${s.capacity}` : ''}{s.status !== 'ACTIVE' ? ' · Inactive' : ''}</span>
                      </span>
                    </button>
                  ))}
                  {canEdit && !closed && <Button size="sm" variant="ghost" onClick={() => setDivDlg({ cls: c })}><Plus /> Division</Button>}
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryView>
      {classDlg && ctx.yearId && <ClassDialog yearId={ctx.yearId} cls={classDlg === 'new' ? null : classDlg} defaultMedium={mediumId} onClose={() => setClassDlg(null)} />}
      {divDlg && <DivisionDialog cls={divDlg.cls} div={divDlg.div} onClose={() => setDivDlg(null)} />}
    </>
  );
}

const classUpdate = z.object({ displayName: z.string().trim().min(1, 'Name is required').max(60), gradingSystemId: z.number().nullable(), status: z.enum(['ACTIVE', 'INACTIVE']) });

function ClassDialog({ yearId, cls, defaultMedium, onClose }: { yearId: number; cls: SchoolClass | null; defaultMedium: number | ''; onClose: () => void }) {
  const mediums = useMediums();
  const standards = useStandards();
  const grading = useGradingSystems();
  const createForm = useZodForm(classSchema, { academicYearId: yearId, mediumId: defaultMedium || undefined, standardId: undefined, displayName: '', gradingSystemId: grading.data?.[0]?.id ?? null, status: 'ACTIVE' });
  const editForm = useZodForm(classUpdate, { displayName: cls?.displayName ?? '', gradingSystemId: cls?.gradingSystemId ?? null, status: (cls?.status as 'ACTIVE') ?? 'ACTIVE' });
  const save = useSave((v: object) => (cls ? api.patch(`/classes/${cls.id}`, v) : api.post('/classes', v)), {
    invalidate: [['classes'], ['dashboard']], success: 'Class saved', onSuccess: onClose,
    onError: (e) => applyServerErrors(e, (cls ? editForm.setError : createForm.setError) as never, ['mediumId', 'standardId', 'displayName', 'gradingSystemId']),
  });
  const gradingSelect = (reg: object) => (
    <Select id="gs" {...reg}>
      <option value="">None</option>
      {grading.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
    </Select>
  );
  if (cls) {
    const e = editForm.formState.errors;
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent title={`Edit ${cls.displayName}`} description={`${cls.medium.nameEn} · Standard ${cls.standard.nameEn}. Medium and standard cannot change once created.`}>
          <form onSubmit={editForm.handleSubmit((v) => save.mutate(v))} className="grid gap-4" noValidate>
            <Field label="Display name" htmlFor="dn" required error={err(e.displayName)}><Input id="dn" {...editForm.register('displayName')} /></Field>
            <Field label="Grading system" htmlFor="gs">{gradingSelect(editForm.register('gradingSystemId', { setValueAs: (v) => (v === '' || v == null ? null : Number(v)) }))}</Field>
            <Field label="Status" htmlFor="st"><Select id="st" {...editForm.register('status')}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select></Field>
            <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }
  const e = createForm.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add class" description="A class is one standard in one medium for this academic year.">
        <form onSubmit={createForm.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Medium" htmlFor="md" required error={err(e.mediumId)}>
            <Select id="md" {...createForm.register('mediumId')}><option value="">Choose…</option>{mediums.data?.filter((m) => m.status === 'ACTIVE').map((m) => <option key={m.id} value={m.id}>{m.nameEn}</option>)}</Select>
          </Field>
          <Field label="Standard" htmlFor="sd" required error={err(e.standardId)}>
            <Select id="sd" {...createForm.register('standardId')}><option value="">Choose…</option>{standards.data?.filter((s) => s.status === 'ACTIVE').map((s) => <option key={s.id} value={s.id}>{s.nameEn}</option>)}</Select>
          </Field>
          <Field label="Display name" htmlFor="dn2" error={err(e.displayName)} hint="Leave blank for e.g. ENGLISH-X"><Input id="dn2" {...createForm.register('displayName')} /></Field>
          <Field label="Grading system" htmlFor="gs">{gradingSelect(createForm.register('gradingSystemId', { setValueAs: (v) => (v === '' || v == null ? null : Number(v)) }))}</Field>
          <DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Add class</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DivisionDialog({ cls, div, onClose }: { cls: SchoolClass; div?: Division; onClose: () => void }) {
  const form = useZodForm(sectionSchema, { name: div?.name ?? '', capacity: div?.capacity ?? null, room: div?.room ?? '', status: (div?.status as 'ACTIVE') ?? 'ACTIVE' });
  const save = useSave((v: z.output<typeof sectionSchema>) => (div ? api.patch(`/sections/${div.id}`, v) : api.post(`/classes/${cls.id}/sections`, v)), {
    invalidate: [['classes'], ['dashboard']], success: 'Division saved', onSuccess: onClose,
    onError: (e) => applyServerErrors(e, form.setError, ['name', 'capacity', 'room']),
  });
  const e = form.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={div ? `Edit ${cls.displayName}-${div.name}` : `Add division to ${cls.displayName}`} description="Class teachers are set in Teacher Assignments.">
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Division" htmlFor="dv" required error={err(e.name)}><Input id="dv" placeholder="A" {...form.register('name')} /></Field>
          <Field label="Capacity" htmlFor="cp" error={err(e.capacity)}><Input id="cp" type="number" min={1} {...form.register('capacity', { setValueAs: (v) => (v === '' || v == null ? null : Number(v)) })} /></Field>
          <Field label="Room" htmlFor="rm" error={err(e.room)}><Input id="rm" {...form.register('room')} /></Field>
          <Field label="Status" htmlFor="ds"><Select id="ds" {...form.register('status')}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select></Field>
          <DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= Class subject list
interface Row {
  subject: Subject;
  included: boolean;
  isOptional: boolean;
  includeInTotal: boolean;
  defaultMaxMarks: string;
  defaultPassMarks: string;
  reportRollup: string;
  displayOrder: number;
}

export function ClassSubjectsPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const canEdit = can(P.ACADEMICS_MANAGE);
  const cls = useQuery({ queryKey: ['class', id], queryFn: () => api.get<SchoolClass & { academicYear: { name: string; status: string } }>(`/classes/${id}`) });
  const current = useQuery({ queryKey: ['class-subjects', id], queryFn: () => api.get<ClassSubject[]>(`/classes/${id}/subjects`) });
  const subjects = useQuery({
    queryKey: ['subjects', cls.data?.mediumId],
    queryFn: () => api.get<Subject[]>(`/subjects${qs({ mediumId: cls.data?.mediumId })}`),
    enabled: !!cls.data,
  });
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    if (!subjects.data || !current.data) return;
    const byId = new Map(current.data.map((c) => [c.subjectId, c]));
    // Parents first, each followed by its papers.
    const active = subjects.data.filter((s) => s.status === 'ACTIVE' || byId.get(s.id)?.status === 'ACTIVE');
    const ordered = active.filter((s) => !s.parentSubjectId).flatMap((p) => [p, ...active.filter((c) => c.parentSubjectId === p.id)]);
    setRows(ordered.map((s, i) => {
      const cs = byId.get(s.id);
      return {
        subject: s, included: cs?.status === 'ACTIVE', isOptional: cs?.isOptional ?? false, includeInTotal: cs?.includeInTotal ?? true,
        defaultMaxMarks: cs?.defaultMaxMarks?.toString() ?? '', defaultPassMarks: cs?.defaultPassMarks?.toString() ?? '',
        reportRollup: cs?.reportRollup ?? 'SELF', displayOrder: cs?.displayOrder ?? i,
      };
    }));
  }, [subjects.data, current.data]);

  const save = useSave(
    (items: object[]) => api.put(`/classes/${id}/subjects`, { items }),
    { invalidate: [['class-subjects', id], ['classes'], ['dashboard']], success: 'Subjects saved' },
  );
  const editable = canEdit && cls.data?.academicYear.status !== 'CLOSED';
  const update = (i: number, patch: Partial<Row>) => setRows((r) => r && r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const submit = () => {
    if (!rows) return;
    save.mutate(rows.filter((r) => r.included).map((r) => ({
      subjectId: r.subject.id, isOptional: r.isOptional, includeInTotal: r.includeInTotal,
      defaultMaxMarks: r.defaultMaxMarks === '' ? null : Number(r.defaultMaxMarks),
      defaultPassMarks: r.defaultPassMarks === '' ? null : Number(r.defaultPassMarks),
      reportRollup: r.reportRollup, displayOrder: r.displayOrder,
    })));
  };

  return (
    <>
      <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild><Link to="/academics/classes"><ArrowLeft /> Classes</Link></Button>
      <PageHeader
        title={cls.data ? `${cls.data.displayName} — subjects` : 'Subjects'}
        description={cls.data ? `${cls.data.medium.nameEn} · ${cls.data.academicYear.name}. Only ${cls.data.medium.nameEn} subjects can be added. Default marks are used as starting values when exams are set up.` : undefined}
        actions={editable && <Button onClick={submit} loading={save.isPending} disabled={!rows}>Save subjects</Button>}
      />
      <Section title="Subjects and papers">
        {!rows ? <QueryView query={subjects}>{() => null}</QueryView> : rows.length === 0 ? (
          <EmptyState icon={BookOpen} title="No subjects in this medium" description="Create subjects first." action={<Button asChild variant="outline"><Link to="/academics/subjects">Go to Subjects</Link></Button>} />
        ) : (
          <Table>
            <THead><TR><TH className="w-10">Use</TH><TH>Subject</TH><TH>Optional</TH><TH>In total</TH><TH>Default max</TH><TH>Default pass</TH><TH>On report card</TH><TH>Order</TH></TR></THead>
            <TBody>
              {rows.map((r, i) => (
                <TR key={r.subject.id} className={cn(!r.included && 'text-muted-foreground')}>
                  <TD><Checkbox aria-label={`Include ${r.subject.nameEn}`} checked={r.included} disabled={!editable} onChange={(e) => update(i, { included: e.target.checked })} /></TD>
                  <TD className={cn(r.subject.parentSubjectId && 'pl-8')}>
                    <span className="font-medium">{r.subject.nameEn}</span>
                    {r.subject.parentSubjectId && <Badge variant="outline" className="ml-2">paper</Badge>}
                    {r.subject.area === 'CO_SCHOLASTIC' && <Badge variant="secondary" className="ml-2">co-scholastic</Badge>}
                  </TD>
                  <TD><Checkbox aria-label="Optional" checked={r.isOptional} disabled={!editable || !r.included} onChange={(e) => update(i, { isOptional: e.target.checked })} /></TD>
                  <TD><Checkbox aria-label="Include in total" checked={r.includeInTotal} disabled={!editable || !r.included} onChange={(e) => update(i, { includeInTotal: e.target.checked })} /></TD>
                  <TD><Input aria-label="Default maximum marks" className="h-8 w-20" type="number" min={1} value={r.defaultMaxMarks} disabled={!editable || !r.included} onChange={(e) => update(i, { defaultMaxMarks: e.target.value })} /></TD>
                  <TD><Input aria-label="Default pass marks" className="h-8 w-20" type="number" min={0} value={r.defaultPassMarks} disabled={!editable || !r.included} onChange={(e) => update(i, { defaultPassMarks: e.target.value })} /></TD>
                  <TD>
                    {r.subject.parentSubjectId ? (
                      <Select aria-label="Report card display" className="h-8 w-40 text-xs" value={r.reportRollup} disabled={!editable || !r.included} onChange={(e) => update(i, { reportRollup: e.target.value })}>
                        {REPORT_ROLLUP.map((v) => <option key={v} value={v}>{v === 'SELF' ? 'Own row' : v === 'INTO_PARENT' ? 'Add into parent' : 'Both'}</option>)}
                      </Select>
                    ) : <span className="text-xs text-muted-foreground">Own row</span>}
                  </TD>
                  <TD><Input aria-label="Display order" className="h-8 w-16" type="number" min={0} value={r.displayOrder} disabled={!editable || !r.included} onChange={(e) => update(i, { displayOrder: Number(e.target.value) })} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
    </>
  );
}

// ======================================================================= Subjects
export function SubjectsPage() {
  const { can } = useAuth();
  const canEdit = can(P.ACADEMICS_MANAGE);
  const ctx = useWorkingContext();
  const [mediumId, setMediumId] = useState<number | ''>(ctx.mediumId ?? '');
  const q = useQuery({ queryKey: ['subjects', mediumId || null], queryFn: () => api.get<Subject[]>(`/subjects${qs({ mediumId })}`) });
  const [dlg, setDlg] = useState<Subject | 'new' | null>(null);
  const ordered = useMemo(() => {
    const list = q.data ?? [];
    return list.filter((s) => !s.parentSubjectId).flatMap((p) => [p, ...list.filter((c) => c.parentSubjectId === p.id)]);
  }, [q.data]);
  return (
    <>
      <PageHeader
        title="Subjects & Papers"
        description="Subjects belong to one medium. Papers (e.g. Algebra, Geometry) sit under a subject (Mathematics)."
        actions={<><MediumFilter value={mediumId} onChange={setMediumId} />{canEdit && <Button onClick={() => setDlg('new')}><Plus /> Add subject</Button>}</>}
      />
      <Section title="Subjects">
        <QueryView query={q} empty={(d) => (d.length ? null : <EmptyState icon={BookOpen} title="No subjects" description="Add the subjects taught in each medium." />)}>
          {() => (
            <Table>
              <THead><TR><TH>Code</TH><TH>Subject</TH><TH>Medium</TH><TH>Type</TH><TH>Area</TH><TH>Status</TH>{canEdit && <TH />}</TR></THead>
              <TBody>
                {ordered.map((s) => (
                  <TR key={s.id}>
                    <TD className="font-mono text-xs">{s.code}</TD>
                    <TD className={cn('font-medium', s.parentSubjectId && 'pl-8 font-normal')}>
                      {s.parentSubjectId && <span className="mr-1 text-muted-foreground">↳</span>}{s.nameEn}
                      {s._count.papers > 0 && <Badge variant="outline" className="ml-2">{s._count.papers} papers</Badge>}
                    </TD>
                    <TD>{s.medium.nameEn}</TD>
                    <TD>{label(s.subjectType)}</TD>
                    <TD>{s.area === 'CO_SCHOLASTIC' ? 'Co-scholastic' : 'Scholastic'}</TD>
                    <TD><StatusBadge status={s.status} /></TD>
                    {canEdit && <TD><Button size="sm" variant="ghost" onClick={() => setDlg(s)} aria-label={`Edit ${s.nameEn}`}><Pencil /></Button></TD>}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>
      {dlg && <SubjectDialog subject={dlg === 'new' ? null : dlg} defaultMedium={mediumId} all={q.data ?? []} onClose={() => setDlg(null)} />}
    </>
  );
}

function SubjectDialog({ subject, defaultMedium, all, onClose }: { subject: Subject | null; defaultMedium: number | ''; all: Subject[]; onClose: () => void }) {
  const mediums = useMediums();
  const form = useZodForm(subjectSchema, {
    mediumId: subject?.mediumId ?? (defaultMedium || undefined), code: subject?.code ?? '', nameEn: subject?.nameEn ?? '', nameHi: subject?.nameHi ?? '',
    shortName: subject?.shortName ?? '', subjectType: (subject?.subjectType as 'THEORY') ?? 'THEORY', area: (subject?.area as 'SCHOLASTIC') ?? 'SCHOLASTIC',
    parentSubjectId: subject?.parentSubjectId ?? null, status: (subject?.status as 'ACTIVE') ?? 'ACTIVE',
  });
  const medium = Number(form.watch('mediumId'));
  // Possible parents: top-level subjects in the same medium (fetched for that medium).
  const parents = useQuery({ queryKey: ['subjects', medium], queryFn: () => api.get<Subject[]>(`/subjects?mediumId=${medium}`), enabled: !!medium, initialData: medium ? undefined : all });
  const save = useSave((v: z.output<typeof subjectSchema>) => (subject ? api.patch(`/subjects/${subject.id}`, v) : api.post('/subjects', v)), {
    invalidate: [['subjects'], ['dashboard']], success: 'Subject saved', onSuccess: onClose,
    onError: (e) => applyServerErrors(e, form.setError, ['mediumId', 'code', 'nameEn', 'nameHi', 'shortName', 'parentSubjectId']),
  });
  const e = form.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={subject ? `Edit ${subject.nameEn}` : 'Add subject'} wide>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Medium" htmlFor="sm" required error={err(e.mediumId)}>
            <Select id="sm" {...form.register('mediumId')}><option value="">Choose…</option>{mediums.data?.map((m) => <option key={m.id} value={m.id}>{m.nameEn}</option>)}</Select>
          </Field>
          <Field label="Code" htmlFor="scd" required error={err(e.code)}><Input id="scd" placeholder="ALG" {...form.register('code')} /></Field>
          <Field label="Name" htmlFor="snm" required error={err(e.nameEn)}><Input id="snm" placeholder="Algebra" {...form.register('nameEn')} /></Field>
          <Field label="Short name" htmlFor="ssn" error={err(e.shortName)} hint="Used in narrow columns, e.g. Geom."><Input id="ssn" {...form.register('shortName')} /></Field>
          <Field label="Paper of" htmlFor="spr" error={err(e.parentSubjectId)} hint="Leave empty for a main subject">
            <Select id="spr" {...form.register('parentSubjectId', { setValueAs: (v) => (v === '' || v == null ? null : Number(v)) })}>
              <option value="">— Main subject —</option>
              {parents.data?.filter((s) => !s.parentSubjectId && s.id !== subject?.id).map((s) => <option key={s.id} value={s.id}>{s.nameEn}</option>)}
            </Select>
          </Field>
          <Field label="Type" htmlFor="sty"><Select id="sty" {...form.register('subjectType')}>{SUBJECT_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
          <Field label="Area" htmlFor="sar" hint="Co-scholastic: Work Exp., Art, Phy. Edu."><Select id="sar" {...form.register('area')}>{SUBJECT_AREAS.map((t) => <option key={t} value={t}>{t === 'SCHOLASTIC' ? 'Scholastic' : 'Co-scholastic'}</option>)}</Select></Field>
          <Field label="Status" htmlFor="sst"><Select id="sst" {...form.register('status')}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select></Field>
          <DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= Grading systems
export function GradingPage() {
  const { can } = useAuth();
  const canEdit = can(P.ACADEMICS_MANAGE);
  const q = useGradingSystems();
  const [dlg, setDlg] = useState<GradingSystem | 'new' | null>(null);
  return (
    <>
      <PageHeader title="Grading Systems" description="Percentage bands that turn marks into grades. Assigned per class or per subject." actions={canEdit && <Button onClick={() => setDlg('new')}><Plus /> Add grading system</Button>} />
      <QueryView query={q} empty={(d) => (d.length ? null : <Card><EmptyState title="No grading systems" /></Card>)}>
        {(list) => (
          <div className="grid gap-4 md:grid-cols-2">
            {list.map((g) => (
              <Section key={g.id} title={g.name} actions={<div className="flex items-center gap-2"><StatusBadge status={g.status} />{canEdit && <Button size="sm" variant="ghost" onClick={() => setDlg(g)}><Pencil /> Edit</Button>}</div>}>
                <Table>
                  <THead><TR><TH>Grade</TH><TH>From %</TH><TH>To %</TH><TH>Point</TH><TH>Result</TH></TR></THead>
                  <TBody>
                    {g.bands.map((b) => (
                      <TR key={b.grade}><TD className="font-semibold">{b.grade}</TD><TD className="tabular-nums">{b.minPercent}</TD><TD className="tabular-nums">{b.maxPercent}</TD><TD>{b.gradePoint ?? '—'}</TD><TD>{b.isPass ? <Badge variant="success">Pass</Badge> : <Badge variant="destructive">Fail</Badge>}</TD></TR>
                    ))}
                  </TBody>
                </Table>
              </Section>
            ))}
          </div>
        )}
      </QueryView>
      {dlg && <GradingDialog system={dlg === 'new' ? null : dlg} onClose={() => setDlg(null)} />}
    </>
  );
}

function GradingDialog({ system, onClose }: { system: GradingSystem | null; onClose: () => void }) {
  const [name, setName] = useState(system?.name ?? '');
  const [status, setStatus] = useState(system?.status ?? 'ACTIVE');
  const [bands, setBands] = useState<GradeBand[]>(system?.bands.map((b) => ({ ...b })) ?? [{ grade: '', minPercent: 0, maxPercent: 100, gradePoint: null, labelEn: null, labelHi: null, isPass: true }]);
  const problems = validateGradeBands(bands.map((b) => ({ ...b, minPercent: Number(b.minPercent), maxPercent: Number(b.maxPercent) })));
  const save = useSave((v: z.input<typeof gradingSystemSchema>) => (system ? api.put(`/grading-systems/${system.id}`, v) : api.post('/grading-systems', v)), {
    invalidate: [['grading-systems'], ['dashboard']], success: 'Grading system saved', onSuccess: onClose,
  });
  const set = (i: number, patch: Partial<GradeBand>) => setBands((b) => b.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={system ? `Edit ${system.name}` : 'Add grading system'} description="Bands must cover 0–100 without gaps or overlaps. A percentage gets the band whose 'From' it reaches." wide>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="gn" required error={!name.trim() ? 'Name is required' : undefined}><Input id="gn" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Status" htmlFor="gst"><Select id="gst" value={status} onChange={(e) => setStatus(e.target.value)}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select></Field>
        </div>
        <Table>
          <THead><TR><TH>Grade</TH><TH>From %</TH><TH>To %</TH><TH>Point</TH><TH>Pass</TH><TH /></TR></THead>
          <TBody>
            {bands.map((b, i) => (
              <TR key={i}>
                <TD><Input aria-label="Grade" className="h-8 w-20" value={b.grade} onChange={(e) => set(i, { grade: e.target.value })} /></TD>
                <TD><Input aria-label="From percent" className="h-8 w-24" type="number" step="0.01" value={b.minPercent} onChange={(e) => set(i, { minPercent: Number(e.target.value) })} /></TD>
                <TD><Input aria-label="To percent" className="h-8 w-24" type="number" step="0.01" value={b.maxPercent} onChange={(e) => set(i, { maxPercent: Number(e.target.value) })} /></TD>
                <TD><Input aria-label="Grade point" className="h-8 w-20" type="number" step="0.01" value={b.gradePoint ?? ''} onChange={(e) => set(i, { gradePoint: e.target.value === '' ? null : Number(e.target.value) })} /></TD>
                <TD><Checkbox aria-label="Pass" checked={b.isPass} onChange={(e) => set(i, { isPass: e.target.checked })} /></TD>
                <TD><Button size="sm" variant="ghost" disabled={bands.length === 1} onClick={() => setBands((x) => x.filter((_, j) => j !== i))} aria-label="Remove band"><Trash2 /></Button></TD>
              </TR>
            ))}
          </TBody>
        </Table>
        <div><Button size="sm" variant="outline" onClick={() => setBands((b) => [...b, { grade: '', minPercent: 0, maxPercent: 0, gradePoint: null, labelEn: null, labelHi: null, isPass: true }])}><Plus /> Add band</Button></div>
        {problems.length > 0 && <ul className="list-inside list-disc text-sm text-destructive" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} disabled={problems.length > 0 || !name.trim()} onClick={() => save.mutate({ name, status: status as 'ACTIVE', bands })}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
