import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import {
  academicTermSchema, academicYearSchema, mediumSchema, PERMISSIONS, schoolProfileSchema, sequenceUpdateSchema, standardSchema, WEEKDAYS, formatSequence, yearToken,
} from '@cps/shared';
import { CalendarPlus, CheckCircle2, ImageUp, Lock, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm, type DefaultValues, type FieldValues } from 'react-hook-form';
import type { z } from 'zod';
import { applyServerErrors, ConfirmDialog, EmptyState, PageHeader, QueryView, Section, StatusBadge, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useMediums, useStandards, useYears } from '@/lib/hooks';
import type { AcademicYear, EffectivePolicy, Medium, NumberSequence, PolicyOverride, School, Standard, Term } from '@/lib/types';
import { formatDate, formatDateTime, isoDay } from '@/lib/utils';

const P = PERMISSIONS;

/** Typed form bound to a shared Zod schema (input type in the form, parsed output on submit). */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(schema: S, defaultValues: DefaultValues<z.input<S>>) {
  return useForm<z.input<S>, unknown, z.output<S>>({ resolver: zodResolver(schema as never) as never, defaultValues });
}

export const err = (e: { message?: unknown } | undefined) => (typeof e?.message === 'string' ? e.message : undefined);

// ======================================================================= School profile
function BrandingImage({ fileId, label, kind, canEdit }: { fileId: number | null; label: string; kind: string; canEdit: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const img = useQuery({
    queryKey: ['file', fileId],
    queryFn: async () => URL.createObjectURL(await api.get<Blob>(`/files/${fileId}/content`)),
    enabled: !!fileId,
    staleTime: Infinity,
  });
  const upload = useSave((f: File) => { const fd = new FormData(); fd.append('file', f); return api.post(`/school/${kind}`, fd); }, { invalidate: [['school'], ['me'], ['dashboard']], success: `${label} uploaded` });
  return (
    <div className="flex items-center gap-4">
      <div className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted/40">
        {img.data ? <img src={img.data} alt={label} className="max-h-full max-w-full object-contain" /> : <ImageUp className="size-6 text-muted-foreground" />}
      </div>
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mb-2 text-xs text-muted-foreground">PNG, JPEG or WebP, up to 2 MB</p>
        {canEdit && (
          <>
            <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
            <Button size="sm" variant="outline" loading={upload.isPending} onClick={() => ref.current?.click()}>{fileId ? 'Replace' : 'Upload'}</Button>
          </>
        )}
      </div>
    </div>
  );
}

export function SchoolProfilePage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['school'], queryFn: () => api.get<School>('/school') });
  return (
    <>
      <PageHeader title="School Profile" description="Shown on report cards, certificates and printed registers." />
      <QueryView query={q}>{(s) => <SchoolForm school={s} canEdit={can(P.SETTINGS_MANAGE)} />}</QueryView>
    </>
  );
}

function SchoolForm({ school, canEdit }: { school: School; canEdit: boolean }) {
  const form = useZodForm(schoolProfileSchema, {
    name: school.name, nameHi: school.nameHi ?? '', motto: school.motto ?? '', addressLine: school.addressLine, city: school.city ?? '',
    state: school.state ?? '', pincode: school.pincode ?? '', phone: school.phone ?? '', email: school.email ?? '', website: school.website ?? '',
    udiseCode: school.udiseCode ?? '', registrationNo: school.registrationNo ?? '', board: school.board ?? '',
    principalName: school.principalName ?? '', principalTitle: school.principalTitle ?? '',
  });
  const save = useSave((v: z.output<typeof schoolProfileSchema>) => api.patch('/school', v), {
    invalidate: [['school'], ['me'], ['dashboard']], success: 'School profile saved',
    onError: (e) => applyServerErrors(e, form.setError, Object.keys(schoolProfileSchema.shape)),
  });
  const e = form.formState.errors;
  const text = (name: keyof z.input<typeof schoolProfileSchema>, label: string, opts: { required?: boolean; hint?: string; lang?: string; className?: string } = {}) => (
    <Field label={label} htmlFor={name} required={opts.required} error={err(e[name])} hint={opts.hint} className={opts.className}>
      <Input id={name} lang={opts.lang} disabled={!canEdit} aria-invalid={!!e[name]} {...form.register(name)} />
    </Field>
  );
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Section title="Details" className="lg:col-span-2">
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 p-5 sm:grid-cols-2" noValidate>
          {text('name', 'School name', { required: true })}
          {text('motto', 'Motto', { lang: 'hi' })}
          {text('board', 'Board')}
          {text('addressLine', 'Address', { required: true, className: 'sm:col-span-2' })}
          {text('city', 'City')}
          {text('state', 'State')}
          {text('pincode', 'PIN code')}
          {text('phone', 'Phone')}
          {text('email', 'Email')}
          {text('website', 'Website')}
          {text('udiseCode', 'UDISE code')}
          {text('registrationNo', 'Registration number')}
          {text('principalName', 'Principal / Head name')}
          {text('principalTitle', 'Signature title', { hint: 'Printed under the signature, e.g. Head Mistress' })}
          {canEdit && (
            <div className="flex justify-end sm:col-span-2">
              <Button type="submit" loading={save.isPending} disabled={!form.formState.isDirty}>Save changes</Button>
            </div>
          )}
        </form>
      </Section>
      <Section title="Branding" description="Used on report cards and certificates.">
        <div className="grid gap-5 p-5">
          <BrandingImage fileId={school.logoFileId} label="School logo" kind="logo" canEdit={canEdit} />
          <BrandingImage fileId={school.principalSignFileId} label="Principal's signature" kind="principal-signature" canEdit={canEdit} />
          <BrandingImage fileId={school.stampFileId} label="School stamp" kind="stamp" canEdit={canEdit} />
        </div>
      </Section>
    </div>
  );
}

// ======================================================================= Academic years & terms
export function AcademicYearsPage() {
  const { can } = useAuth();
  const canEdit = can(P.SETTINGS_MANAGE);
  const years = useYears();
  const [editing, setEditing] = useState<AcademicYear | 'new' | null>(null);
  const [term, setTerm] = useState<{ year: AcademicYear; term?: Term } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'current' | 'close' | 'deleteTerm'; year: AcademicYear; term?: Term } | null>(null);
  const action = useSave(
    (c: NonNullable<typeof confirm>) =>
      c.kind === 'deleteTerm' ? api.delete(`/academic-years/${c.year.id}/terms/${c.term!.id}`) : api.post(`/academic-years/${c.year.id}/${c.kind === 'current' ? 'set-current' : 'close'}`),
    { invalidate: [['academic-years'], ['me'], ['dashboard']], success: 'Done', onSuccess: () => setConfirm(null) },
  );

  return (
    <>
      <PageHeader
        title="Academic Years"
        description="Each year keeps its own classes, enrollments, attendance and results. Closed years stay readable."
        actions={canEdit && <Button onClick={() => setEditing('new')}><Plus /> New academic year</Button>}
      />
      <QueryView query={years} empty={(d) => (d.length ? null : <EmptyState title="No academic years" description="Create the current academic year to begin." />)}>
        {(list) => (
          <div className="grid gap-4">
            {list.map((y) => (
              <Card key={y.id}>
                <div className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold">{y.name}</h2>
                      {y.isCurrent && <Badge variant="success"><CheckCircle2 className="size-3" /> Current</Badge>}
                      <StatusBadge status={y.status} />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {formatDate(y.startDate)} – {formatDate(y.endDate)} · Weekly off: {y.weeklyOffDays.map((d) => WEEKDAYS[d].en).join(', ') || 'none'} · {y._count?.classes ?? 0} classes
                    </p>
                  </div>
                  {canEdit && y.status !== 'CLOSED' && (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditing(y)}><Pencil /> Edit</Button>
                      {!y.isCurrent && <Button size="sm" variant="outline" onClick={() => setConfirm({ kind: 'current', year: y })}>Make current</Button>}
                      {!y.isCurrent && <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'close', year: y })}><Lock /> Close</Button>}
                    </div>
                  )}
                </div>
                <div className="px-5 py-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-medium">Terms</h3>
                    {canEdit && y.status !== 'CLOSED' && <Button size="sm" variant="ghost" onClick={() => setTerm({ year: y })}><CalendarPlus /> Add term</Button>}
                  </div>
                  {y.terms.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No terms yet. Add Semester I and Semester II so attendance and exams can be grouped.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {y.terms.map((t) => (
                        <div key={t.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                          <span className="font-medium">{t.nameEn}</span>
                          <span className="text-muted-foreground">{formatDate(t.startDate)} – {formatDate(t.endDate)}</span>
                          {canEdit && y.status !== 'CLOSED' && (
                            <>
                              <button className="text-muted-foreground hover:text-foreground" onClick={() => setTerm({ year: y, term: t })} aria-label={`Edit ${t.nameEn}`}><Pencil className="size-3.5" /></button>
                              <button className="text-muted-foreground hover:text-destructive" onClick={() => setConfirm({ kind: 'deleteTerm', year: y, term: t })} aria-label={`Delete ${t.nameEn}`}><Trash2 className="size-3.5" /></button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryView>
      {editing && <YearDialog year={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {term && <TermDialog year={term.year} term={term.term} onClose={() => setTerm(null)} />}
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={confirm.kind === 'current' ? `Make ${confirm.year.name} the current year?` : confirm.kind === 'close' ? `Close ${confirm.year.name}?` : `Delete ${confirm.term?.nameEn}?`}
          description={
            confirm.kind === 'current' ? 'New work (attendance, marks) will default to this year for everyone.'
              : confirm.kind === 'close' ? 'A closed year becomes read-only. Its records stay available for reports and reprints.'
                : 'The term is removed from this year.'
          }
          confirmLabel={confirm.kind === 'current' ? 'Make current' : confirm.kind === 'close' ? 'Close year' : 'Delete'}
          destructive={confirm.kind !== 'current'}
          loading={action.isPending}
          onConfirm={() => action.mutate(confirm)}
        />
      )}
    </>
  );
}

function YearDialog({ year, onClose }: { year: AcademicYear | null; onClose: () => void }) {
  const form = useZodForm(academicYearSchema, {
    name: year?.name ?? '', startDate: isoDay(year?.startDate), endDate: isoDay(year?.endDate), weeklyOffDays: year?.weeklyOffDays ?? [0],
  });
  const offs = form.watch('weeklyOffDays') ?? [];
  const save = useSave((v: z.output<typeof academicYearSchema>) => (year ? api.patch(`/academic-years/${year.id}`, v) : api.post('/academic-years', v)), {
    invalidate: [['academic-years'], ['dashboard']], success: 'Academic year saved', onSuccess: onClose,
    onError: (e) => applyServerErrors(e, form.setError, ['name', 'startDate', 'endDate']),
  });
  const e = form.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={year ? `Edit ${year.name}` : 'New academic year'}>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4" noValidate>
          <Field label="Name" htmlFor="name" required error={err(e.name)} hint="Format 2026-27"><Input id="name" placeholder="2027-28" {...form.register('name')} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start date" htmlFor="sd" required error={err(e.startDate)}><Input id="sd" type="date" {...form.register('startDate')} /></Field>
            <Field label="End date" htmlFor="ed" required error={err(e.endDate)}><Input id="ed" type="date" {...form.register('endDate')} /></Field>
          </div>
          <Field label="Weekly off days" hint="Used to count working days for attendance">
            <div className="flex flex-wrap gap-3">
              {WEEKDAYS.map((d) => (
                <label key={d.value} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={offs.includes(d.value)} onChange={(ev) => form.setValue('weeklyOffDays', ev.target.checked ? [...offs, d.value].sort() : offs.filter((x) => x !== d.value), { shouldDirty: true })} />
                  {d.en}
                </label>
              ))}
            </div>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TermDialog({ year, term, onClose }: { year: AcademicYear; term?: Term; onClose: () => void }) {
  const form = useZodForm(academicTermSchema, {
    code: term?.code ?? '', nameEn: term?.nameEn ?? '', nameHi: term?.nameHi ?? '',
    startDate: isoDay(term?.startDate), endDate: isoDay(term?.endDate), sequence: term?.sequence ?? year.terms.length + 1,
  });
  const save = useSave((v: z.output<typeof academicTermSchema>) => (term ? api.patch(`/academic-years/${year.id}/terms/${term.id}`, v) : api.post(`/academic-years/${year.id}/terms`, v)), {
    invalidate: [['academic-years']], success: 'Term saved', onSuccess: onClose,
    onError: (e) => applyServerErrors(e, form.setError, ['code', 'nameEn', 'startDate', 'endDate', 'sequence']),
  });
  const e = form.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={term ? `Edit ${term.nameEn}` : `Add term to ${year.name}`} description={`Must fall within ${formatDate(year.startDate)} – ${formatDate(year.endDate)} and not overlap other terms.`}>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Code" htmlFor="code" required error={err(e.code)}><Input id="code" placeholder="SEM1" {...form.register('code')} /></Field>
          <Field label="Order" htmlFor="seq" required error={err(e.sequence)}><Input id="seq" type="number" min={1} {...form.register('sequence')} /></Field>
          <Field label="Name" htmlFor="nameEn" required error={err(e.nameEn)}><Input id="nameEn" placeholder="Semester I" {...form.register('nameEn')} /></Field>
          <Field label="Start date" htmlFor="tsd" required error={err(e.startDate)}><Input id="tsd" type="date" {...form.register('startDate')} /></Field>
          <Field label="End date" htmlFor="ted" required error={err(e.endDate)}><Input id="ted" type="date" {...form.register('endDate')} /></Field>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= Mediums & standards
export function MediumsPage() {
  const { can } = useAuth();
  const canEdit = can(P.SETTINGS_MANAGE);
  const mediums = useMediums();
  const standards = useStandards();
  const [m, setM] = useState<Medium | 'new' | null>(null);
  const [s, setS] = useState<Standard | 'new' | null>(null);
  return (
    <>
      <PageHeader title="Mediums & Standards" description="Hindi and English medium are configured independently. Standards are the grade levels (Nursery … X)." />
      <Tabs defaultValue="mediums">
        <TabsList><TabsTrigger value="mediums">Mediums</TabsTrigger><TabsTrigger value="standards">Standards</TabsTrigger></TabsList>
        <TabsContent value="mediums">
          <Section title="Mediums" actions={canEdit && <Button size="sm" onClick={() => setM('new')}><Plus /> Add medium</Button>}>
            <QueryView query={mediums}>
              {(list) => (
                <Table>
                  <THead><TR><TH>Code</TH><TH>Name</TH><TH>Exam No. prefix</TH><TH>Status</TH>{canEdit && <TH className="w-16" />}</TR></THead>
                  <TBody>
                    {list.map((x) => (
                      <TR key={x.id}>
                        <TD className="font-mono text-xs">{x.code}</TD><TD className="font-medium">{x.nameEn}</TD>
                        <TD>{x.examNoPrefix ?? '—'}</TD><TD><StatusBadge status={x.status} /></TD>
                        {canEdit && <TD><Button size="sm" variant="ghost" onClick={() => setM(x)} aria-label={`Edit ${x.nameEn}`}><Pencil /></Button></TD>}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </QueryView>
          </Section>
        </TabsContent>
        <TabsContent value="standards">
          <Section title="Standards" actions={canEdit && <Button size="sm" onClick={() => setS('new')}><Plus /> Add standard</Button>}>
            <QueryView query={standards}>
              {(list) => (
                <Table>
                  <THead><TR><TH>Order</TH><TH>Code</TH><TH>Name</TH><TH>Status</TH>{canEdit && <TH className="w-16" />}</TR></THead>
                  <TBody>
                    {list.map((x) => (
                      <TR key={x.id}>
                        <TD className="tabular-nums text-muted-foreground">{x.levelOrder}</TD><TD className="font-mono text-xs">{x.code}</TD>
                        <TD className="font-medium">{x.nameEn}</TD><TD><StatusBadge status={x.status} /></TD>
                        {canEdit && <TD><Button size="sm" variant="ghost" onClick={() => setS(x)} aria-label={`Edit ${x.nameEn}`}><Pencil /></Button></TD>}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </QueryView>
          </Section>
        </TabsContent>
      </Tabs>
      {m && <MediumDialog medium={m === 'new' ? null : m} onClose={() => setM(null)} />}
      {s && <StandardDialog standard={s === 'new' ? null : s} onClose={() => setS(null)} />}
    </>
  );
}

function MediumDialog({ medium, onClose }: { medium: Medium | null; onClose: () => void }) {
  const form = useZodForm(mediumSchema, {
    code: medium?.code ?? '', nameEn: medium?.nameEn ?? '', nameHi: medium?.nameHi ?? '', examNoPrefix: medium?.examNoPrefix ?? '',
    sortOrder: medium?.sortOrder ?? 0, status: (medium?.status as 'ACTIVE' | 'INACTIVE') ?? 'ACTIVE',
  });
  const save = useSave((v: z.output<typeof mediumSchema>) => (medium ? api.patch(`/mediums/${medium.id}`, v) : api.post('/mediums', v)), {
    invalidate: [['mediums'], ['dashboard']], success: 'Medium saved', onSuccess: onClose,
    onError: (e) => applyServerErrors(e, form.setError, ['code', 'nameEn', 'nameHi', 'examNoPrefix']),
  });
  const e = form.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={medium ? `Edit ${medium.nameEn}` : 'Add medium'}>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Code" htmlFor="mc" required error={err(e.code)}><Input id="mc" placeholder="MR" {...form.register('code')} /></Field>
          <Field label="Exam No. prefix" htmlFor="mp" error={err(e.examNoPrefix)} hint="E.g. H for H1001"><Input id="mp" {...form.register('examNoPrefix')} /></Field>
          <Field label="Name" htmlFor="mn" required error={err(e.nameEn)}><Input id="mn" {...form.register('nameEn')} /></Field>
          <Field label="Display order" htmlFor="mo" error={err(e.sortOrder)}><Input id="mo" type="number" {...form.register('sortOrder')} /></Field>
          <Field label="Status" htmlFor="ms"><Select id="ms" {...form.register('status')}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select></Field>
          <DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StandardDialog({ standard, onClose }: { standard: Standard | null; onClose: () => void }) {
  const form = useZodForm(standardSchema, {
    code: standard?.code ?? '', nameEn: standard?.nameEn ?? '', nameHi: standard?.nameHi ?? '', levelOrder: standard?.levelOrder ?? 0,
    status: (standard?.status as 'ACTIVE' | 'INACTIVE') ?? 'ACTIVE',
  });
  const save = useSave((v: z.output<typeof standardSchema>) => (standard ? api.patch(`/standards/${standard.id}`, v) : api.post('/standards', v)), {
    invalidate: [['standards'], ['dashboard']], success: 'Standard saved', onSuccess: onClose,
    onError: (e) => applyServerErrors(e, form.setError, ['code', 'nameEn', 'nameHi', 'levelOrder']),
  });
  const e = form.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={standard ? `Edit ${standard.nameEn}` : 'Add standard'}>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Code" htmlFor="sc" required error={err(e.code)}><Input id="sc" placeholder="XI" {...form.register('code')} /></Field>
          <Field label="Promotion order" htmlFor="so" required error={err(e.levelOrder)} hint="Next standard = order + 1"><Input id="so" type="number" {...form.register('levelOrder')} /></Field>
          <Field label="Name" htmlFor="sn" required error={err(e.nameEn)}><Input id="sn" {...form.register('nameEn')} /></Field>
          <Field label="Status" htmlFor="ss"><Select id="ss" {...form.register('status')}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select></Field>
          <DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= Policies
type ScopeLevel = 'school' | 'medium' | 'standard';

export function PoliciesPage() {
  const { can } = useAuth();
  const canEdit = can(P.SETTINGS_MANAGE);
  const mediums = useMediums();
  const standards = useStandards();
  const [level, setLevel] = useState<ScopeLevel>('school');
  const [mediumId, setMediumId] = useState<number | ''>('');
  const [standardId, setStandardId] = useState<number | ''>('');
  const scope = {
    academicYearId: null as number | null,
    mediumId: level !== 'school' && mediumId ? mediumId : null,
    standardId: level === 'standard' && standardId ? standardId : null,
  };
  const ready = level === 'school' || (level === 'medium' && mediumId) || (level === 'standard' && mediumId && standardId);
  const effective = useQuery({
    queryKey: ['policies', 'effective', scope],
    queryFn: () => api.get<EffectivePolicy[]>(`/policies/effective${qs({ mediumId: scope.mediumId, standardId: scope.standardId })}`),
    enabled: !!ready,
  });
  const overrides = useQuery({ queryKey: ['policies', 'overrides'], queryFn: () => api.get<PolicyOverride[]>('/policies') });
  const revert = useSave((id: number) => api.delete(`/policies/${id}`), { invalidate: [['policies']], success: 'Reverted to inherited value' });

  const groups = [...new Set(effective.data?.map((p) => p.group) ?? [])];
  return (
    <>
      <PageHeader title="Rules & Policies" description="School-wide defaults can be overridden for a medium or a standard. The most specific setting wins." />
      <Card className="mb-5 flex flex-wrap items-end gap-4 p-4">
        <Field label="Apply to" htmlFor="lvl">
          <Select id="lvl" className="w-48" value={level} onChange={(e) => setLevel(e.target.value as ScopeLevel)}>
            <option value="school">Whole school</option><option value="medium">One medium</option><option value="standard">One standard in a medium</option>
          </Select>
        </Field>
        {level !== 'school' && (
          <Field label="Medium" htmlFor="pm">
            <Select id="pm" className="w-44" value={mediumId} onChange={(e) => setMediumId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choose…</option>{mediums.data?.map((m) => <option key={m.id} value={m.id}>{m.nameEn}</option>)}
            </Select>
          </Field>
        )}
        {level === 'standard' && (
          <Field label="Standard" htmlFor="ps">
            <Select id="ps" className="w-36" value={standardId} onChange={(e) => setStandardId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choose…</option>{standards.data?.map((s) => <option key={s.id} value={s.id}>{s.nameEn}</option>)}
            </Select>
          </Field>
        )}
      </Card>
      {!ready ? (
        <Card><EmptyState title="Choose where the rules apply" description="Pick a medium (and standard) to see and change its rules." /></Card>
      ) : (
        <QueryView query={effective}>
          {(list) => (
            <div className="grid gap-5">
              {groups.map((g) => (
                <Section key={g} title={g}>
                  <div className="divide-y">
                    {list.filter((p) => p.group === g).map((p) => <PolicyRow key={p.key} policy={p} scope={scope} canEdit={canEdit} />)}
                  </div>
                </Section>
              ))}
            </div>
          )}
        </QueryView>
      )}
      <Section title="All overrides" description="Settings that differ from the built-in defaults." className="mt-6">
        <QueryView query={overrides} empty={(d) => (d.length ? null : <EmptyState title="No overrides" description="Every rule uses its default value." />)}>
          {(list) => (
            <Table>
              <THead><TR><TH>Setting</TH><TH>Applies to</TH><TH>Value</TH><TH>Updated</TH>{canEdit && <TH />}</TR></THead>
              <TBody>
                {list.map((o) => (
                  <TR key={o.id}>
                    <TD className="font-medium">{effective.data?.find((p) => p.key === o.policyKey)?.label ?? o.policyKey}</TD>
                    <TD>{[o.academicYear?.name, o.medium?.nameEn, o.standard?.nameEn ? `Std ${o.standard.nameEn}` : null, o.schoolClass?.displayName].filter(Boolean).join(' · ') || 'Whole school'}</TD>
                    <TD className="font-mono text-xs">{JSON.stringify(o.value)}</TD>
                    <TD className="text-muted-foreground">{formatDateTime(o.updatedAt)}</TD>
                    {canEdit && <TD><Button size="sm" variant="ghost" loading={revert.isPending && revert.variables === o.id} onClick={() => revert.mutate(o.id)}><RotateCcw /> Revert</Button></TD>}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>
    </>
  );
}

const STAGES = [
  { value: 'CLASS_VERIFY', label: 'Class teacher verifies' },
  { value: 'COORDINATOR_VERIFY', label: 'Exam coordinator verifies' },
  { value: 'PRINCIPAL_APPROVE', label: 'Principal approves' },
];

function PolicyRow({ policy, scope, canEdit }: { policy: EffectivePolicy; scope: { mediumId: number | null; standardId: number | null }; canEdit: boolean }) {
  const [value, setValue] = useState<unknown>(policy.value);
  useEffect(() => setValue(policy.value), [policy.value]);
  const save = useSave((v: unknown) => api.put('/policies', { policyKey: policy.key, value: v, ...scope }), { invalidate: [['policies']], success: `${policy.label} saved` });
  const changed = JSON.stringify(value) !== JSON.stringify(policy.value);
  const inherited = policy.source === 'DEFAULT' ? 'Default' : policy.scope?.standardId ? 'Set for this standard' : policy.scope?.mediumId ? 'Set for medium' : 'Set for school';

  let control: React.ReactNode;
  if (policy.input === 'select') {
    control = (
      <Select className="w-64" value={String(value)} disabled={!canEdit} onChange={(e) => setValue(e.target.value)}>
        {policy.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    );
  } else if (policy.input === 'boolean') {
    control = <label className="flex items-center gap-2 text-sm"><Checkbox checked={!!value} disabled={!canEdit} onChange={(e) => setValue(e.target.checked)} /> Enabled</label>;
  } else if (policy.input === 'stages') {
    const arr = (value as string[]) ?? [];
    control = (
      <div className="flex flex-wrap gap-3">
        {STAGES.map((s) => (
          <label key={s.value} className="flex items-center gap-1.5 text-sm">
            <Checkbox checked={arr.includes(s.value)} disabled={!canEdit} onChange={(e) => setValue(e.target.checked ? STAGES.map((x) => x.value).filter((x) => x === s.value || arr.includes(x)) : arr.filter((x) => x !== s.value))} />
            {s.label}
          </label>
        ))}
      </div>
    );
  } else {
    control = (
      <div className="flex items-center gap-2">
        <Input className="w-28" type="number" step="any" value={String(value ?? '')} disabled={!canEdit} onChange={(e) => setValue(e.target.value === '' ? '' : Number(e.target.value))} />
        {policy.input === 'percent' && <span className="text-sm text-muted-foreground">%</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{policy.label}</p>
        <p className="text-sm text-muted-foreground">{policy.description}</p>
        <p className="mt-1 text-xs text-muted-foreground">{inherited}</p>
      </div>
      <div className="flex items-center gap-2">
        {control}
        {canEdit && changed && <Button size="sm" loading={save.isPending} onClick={() => save.mutate(value)}>Save</Button>}
      </div>
    </div>
  );
}

// ======================================================================= Number sequences
export function SequencesPage() {
  const { can } = useAuth();
  const canEdit = can(P.SETTINGS_MANAGE);
  const q = useQuery({ queryKey: ['sequences'], queryFn: () => api.get<NumberSequence[]>('/sequences') });
  const [edit, setEdit] = useState<NumberSequence | null>(null);
  return (
    <>
      <PageHeader title="Number Formats" description="How student IDs, exam numbers, receipts and vouchers are numbered (GR numbers are entered by the Headmaster). Numbers are allocated safely even when many people admit students at once." />
      <Section title="Sequences">
        <QueryView query={q}>
          {(list) => (
            <Table>
              <THead><TR><TH>Used for</TH><TH>Pattern</TH><TH>Next number</TH>{canEdit && <TH />}</TR></THead>
              <TBody>
                {list.map((s) => (
                  <TR key={s.id}>
                    <TD className="font-medium">{s.label}</TD><TD className="font-mono text-xs">{s.pattern}</TD>
                    <TD><Badge variant="secondary" className="font-mono">{s.preview}</Badge></TD>
                    {canEdit && <TD><Button size="sm" variant="ghost" onClick={() => setEdit(s)}><Pencil /> Edit</Button></TD>}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>
      {edit && <SequenceDialog seq={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

/** Academic year name for "today" (June–May), e.g. 2026-27, used only for the preview. */
function currentYearName() {
  const d = new Date();
  const y = d.getMonth() >= 5 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String(y + 1).slice(2)}`;
}

function SequenceDialog({ seq, onClose }: { seq: NumberSequence; onClose: () => void }) {
  const form = useZodForm(sequenceUpdateSchema, { pattern: seq.pattern, nextValue: seq.nextValue });
  const save = useSave((v: z.output<typeof sequenceUpdateSchema>) => api.patch(`/sequences/${seq.id}`, v), {
    invalidate: [['sequences']], success: 'Number format saved', onSuccess: onClose,
    onError: (e) => applyServerErrors(e, form.setError, ['pattern', 'nextValue']),
  });
  const e = form.formState.errors;
  const pattern = form.watch('pattern');
  const next = Number(form.watch('nextValue'));
  const hasTokens = typeof pattern === 'string' && /\{(MEDIUM|YEAR)\}/.test(pattern);
  let preview = '—';
  try { if (Number.isFinite(next) && next >= 1) preview = formatSequence(pattern, next, { medium: 'ENG', year: yearToken(currentYearName()) }); } catch { /* invalid pattern */ }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Edit: ${seq.label}`} description="Put {0000} where the running number goes; the number of zeros is the width. {MEDIUM} is replaced by the student's medium (ENG, HIN) and {YEAR} by the academic year (2026).">
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4" noValidate>
          <Field label="Pattern" htmlFor="pat" required error={err(e.pattern)}><Input id="pat" className="font-mono" {...form.register('pattern')} /></Field>
          <Field label="Next number" htmlFor="nv" required error={err(e.nextValue)} hint="Set this after importing existing records so new numbers continue from the last one">
            <Input id="nv" type="number" min={1} {...form.register('nextValue')} />
          </Field>
          <p className="text-sm">Next will be: <span className="font-mono font-semibold">{preview}</span>{hasTokens && <span className="text-muted-foreground"> (English medium; Hindi medium gets HIN)</span>}</p>
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

