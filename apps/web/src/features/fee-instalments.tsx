import { useQuery } from '@tanstack/react-query';
import { INSTALMENT_STATUS_LABELS, type InstalmentLine, type InstalmentStatus, ordinal, rupees, workingDueDate } from '@cps/shared';
import { AlertTriangle, CalendarClock, Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, QueryView, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/overlay';
import { api, qs } from '@/lib/api';
import { useWorkingContext, useYears } from '@/lib/hooks';
import { cn, formatDate } from '@/lib/utils';

// ======================================================================= fee due dates of the year (Fees → Due dates)
// By each date a student must have paid, in total, at least the minimums up to that date. The class fee is not changed.

interface PlanView {
  year: { id: number; name: string; startDate: string; endDate: string; status: string; editable: boolean };
  today: string;
  can: { edit: boolean; penalty: boolean };
  instalments: { id: number; seq: number; label: string; dueDate: string; amount: number; dueOn: string; overdue: boolean; unpaidStudents: number; unpaidAmount: number; penalties: number; penaltyAmount: number }[];
  classes: { classId: number; displayName: string; medium: string; students: number; classFee: number | null; amounts: (number | null)[] | null; previousAmounts: (number | null)[] | null }[];
  previousYear: { id: number; name: string; instalments: { seq: number; label: string; dueDate: string; amount: number }[] } | null;
}
interface Row { label: string; dueDate: string; amount: string }

const isSunday = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
const addYear = (d: string) => `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;
const num = (v: string) => Number(v) || 0;
const asText = (v: number | null | undefined) => (v == null ? '' : String(v));

export function InstalmentPlanTab() {
  const { yearId: workingYear } = useWorkingContext();
  const years = useYears();
  const [params, setParams] = useSearchParams();
  const yearId = params.get('year') ? Number(params.get('year')) : workingYear;
  const current = years.data?.find((y) => y.isCurrent);
  const choices = (years.data ?? []).filter((y) => y.id === yearId || (y.status !== 'CLOSED' && (!current || y.isCurrent || y.startDate > current.startDate)))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const q = useQuery({ queryKey: ['fees', 'instalments', yearId], queryFn: () => api.get<PlanView>(`/fees/instalments${qs({ academicYearId: yearId })}`), enabled: !!yearId });
  const pickYear = (id: number) => { const n = new URLSearchParams({ tab: 'instalments' }); if (id !== workingYear) n.set('year', String(id)); setParams(n, { replace: true }); };
  return (
    <div className="grid gap-4">
      {choices.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Academic year</span>
          {choices.map((y) => (
            <button key={y.id} type="button" onClick={() => pickYear(y.id)}
              className={cn('rounded-full border px-3 py-1', y.id === yearId ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
              {y.name}{y.isCurrent ? ' (current)' : current && y.startDate > current.startDate ? ' (next year)' : ''}
            </button>
          ))}
        </div>
      )}
      <QueryView query={q}>{(d) => <PlanEditor key={d.year.id} d={d} />}</QueryView>
    </div>
  );
}

function PlanEditor({ d }: { d: PlanView }) {
  const fromData = () => ({
    rows: d.instalments.map((i) => ({ label: i.label, dueDate: i.dueDate, amount: asText(i.amount) })),
    own: Object.fromEntries(d.classes.filter((c) => c.amounts).map((c) => [c.classId, c.amounts!.map(asText)])) as Record<number, string[]>,
  });
  const [rows, setRows] = useState<Row[]>(() => fromData().rows);
  // A class's own minimums; an empty box = the amount for all classes.
  const [own, setOwn] = useState<Record<number, string[]>>(() => fromData().own);
  const [dirty, setDirty] = useState(false);
  const [penaltyFor, setPenaltyFor] = useState<PlanView['instalments'][number] | null>(null);
  const [removeFor, setRemoveFor] = useState<PlanView['instalments'][number] | null>(null);
  const edit = d.can.edit;
  useEffect(() => { const f = fromData(); setRows(f.rows); setOwn(f.own); setDirty(false); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  const addRow = () => { setRows([...rows, { label: `${ordinal(rows.length + 1)} due date`, dueDate: '', amount: '' }]); setDirty(true); };
  const removeRow = (i: number) => {
    setRows(rows.filter((_, k) => k !== i).map((r, k) => ({ ...r, label: /^\d+(st|nd|rd|th) due date$/.test(r.label) ? `${ordinal(k + 1)} due date` : r.label })));
    setOwn((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.filter((_, j) => j !== i)])));
    setDirty(true);
  };
  const setRow = (i: number, p: Partial<Row>) => { setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r))); setDirty(true); };
  const setOwnAmount = (classId: number, i: number, v: string) => {
    setOwn((o) => ({ ...o, [classId]: Array.from({ length: rows.length }, (_, k) => (k === i ? v : (o[classId]?.[k] ?? ''))) }));
    setDirty(true);
  };
  const copyPrevious = () => {
    const p = d.previousYear!;
    setRows(p.instalments.map((i) => ({ label: i.label, dueDate: addYear(i.dueDate), amount: asText(i.amount) })));
    setOwn(Object.fromEntries(d.classes.filter((c) => c.previousAmounts).map((c) => [c.classId, c.previousAmounts!.map(asText)])));
    setDirty(true);
    toast.info(`Copied from ${p.name}, with the dates moved one year on. Check them and press Save.`);
  };
  const save = useSave(() => api.put('/fees/instalments', {
    academicYearId: d.year.id,
    instalments: rows.map((r, i) => ({ seq: i + 1, label: r.label, dueDate: r.dueDate, amount: num(r.amount) })),
    classes: Object.entries(own).map(([classId, v]) => ({ classId: Number(classId), amounts: rows.map((_, i) => ((v[i] ?? '').trim() === '' ? null : num(v[i]))) }))
      .filter((c) => c.amounts.some((a) => a != null)),
  }), { invalidate: [['fees']], success: 'Fee due dates saved' });

  const missing = rows.some((r) => !r.dueDate || !r.label.trim() || r.amount.trim() === '');
  const minFor = (classId: number, i: number) => { const v = own[classId]?.[i]; return v != null && v.trim() !== '' ? num(v) : num(rows[i]?.amount ?? ''); };
  // Running total ("by this date, at least … in all") for the amounts for all classes.
  const running = rows.map((_, i) => rows.slice(0, i + 1).reduce((s, r) => s + num(r.amount), 0));
  return (
    <>
      <Card className="flex flex-wrap items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Fee due dates · {d.year.name}</h2>
          <p className="text-sm text-muted-foreground">
            By each date, every student must have paid at least the minimum amounts up to that date, in total. Parents may pay more at any time, or the whole year at once.
            Last year's unpaid balance is due by the first date, and a discount lowers what is due on the last dates. The annual class fee stays as set on the Class fees tab.
            A student who has paid less than what is due by a date is late, and the Headmaster can charge a late fee.
          </p>
        </div>
        {edit && d.previousYear && <Button variant="outline" onClick={copyPrevious}><Copy /> Copy from {d.previousYear.name}</Button>}
      </Card>

      <Card className="p-4">
        <h3 className="mb-3 font-semibold">1. Due dates and minimum amounts (all classes)</h3>
        {rows.length ? (
          <div className="grid gap-2">
            {rows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <Field label={i === 0 ? 'Name' : ''} htmlFor={`il${i}`} className="w-40"><Input id={`il${i}`} value={r.label} disabled={!edit} maxLength={40} onChange={(e) => setRow(i, { label: e.target.value })} /></Field>
                <Field label={i === 0 ? 'On or before' : ''} htmlFor={`id${i}`} className="w-44"><Input id={`id${i}`} type="date" value={r.dueDate} disabled={!edit} min={d.year.startDate.slice(0, 10)} max={d.year.endDate.slice(0, 10)} onChange={(e) => setRow(i, { dueDate: e.target.value })} /></Field>
                <Field label={i === 0 ? 'Minimum amount (₹)' : ''} htmlFor={`ia${i}`} className="w-40"><Input id={`ia${i}`} inputMode="decimal" className="text-right tabular-nums" value={r.amount} disabled={!edit} placeholder="e.g. 5000" onChange={(e) => setRow(i, { amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
                <p className="min-w-48 pb-2 text-xs text-muted-foreground">
                  {num(r.amount) > 0 && <>At least <b className="text-foreground">{rupees(running[i])}</b> paid in all by then{i === rows.length - 1 ? ' (or the full fee, if less)' : ''}</>}
                  {r.dueDate && isSunday(r.dueDate) && <span className="block text-amber-700">Sunday: due on {formatDate(workingDueDate(r.dueDate))}</span>}
                </p>
                {edit && <Button type="button" size="sm" variant="ghost" className="mb-1" aria-label={`Remove ${r.label}`} onClick={() => removeRow(i)}><Trash2 /></Button>}
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">No due dates yet: the year's fee can be paid at any time. Add the dates the school sets.</p>}
        {edit && rows.length < 12 && <Button type="button" variant="outline" size="sm" className="mt-3" onClick={addRow}><Plus /> Add due date</Button>}
      </Card>

      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b p-4">
            <h3 className="font-semibold">2. A different amount for a class (optional)</h3>
            <p className="text-sm text-muted-foreground">Leave a box empty to use the amount for all classes. Type an amount only where a class differs.</p>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <THead><TR><TH>Class</TH><TH className="text-right">Annual fee</TH>{rows.map((r, i) => <TH key={i} className="text-right whitespace-nowrap">{r.label}<span className="block text-xs font-normal text-muted-foreground">{r.dueDate ? formatDate(r.dueDate) : '—'}</span></TH>)}</TR></THead>
              <TBody>
                {d.classes.map((c) => {
                  const sum = rows.reduce((s, _, i) => s + minFor(c.classId, i), 0);
                  const fee = c.classFee ?? 0;
                  return (
                    <TR key={c.classId}>
                      <TD className="font-medium whitespace-nowrap">{c.displayName}<span className="block text-xs font-normal text-muted-foreground">{c.students} students</span></TD>
                      <TD className="text-right whitespace-nowrap tabular-nums">
                        {c.classFee != null ? rupees(c.classFee) : <span className="text-amber-700">Not set</span>}
                        {fee > 0 && sum > 0 && sum < fee && <span className="block text-xs text-muted-foreground">{rupees(fee - sum)} more by the last date</span>}
                      </TD>
                      {rows.map((r, i) => (
                        <TD key={i} className="text-right">
                          {edit ? <AmountInput label={`${c.displayName}, ${r.label}`} value={own[c.classId]?.[i] ?? ''} placeholder={r.amount || '0'} onChange={(v) => setOwnAmount(c.classId, i, v)} />
                            : <span className={cn('tabular-nums', !(own[c.classId]?.[i] ?? '').trim() && 'text-muted-foreground')}>{rupees(minFor(c.classId, i))}</span>}
                        </TD>
                      ))}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        </Card>
      )}

      {edit && (rows.length > 0 || d.instalments.length > 0) && (
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={save.isPending} disabled={!dirty || missing} onClick={() => save.mutate(undefined)}>Save due dates</Button>
          {missing && <span className="text-sm text-amber-700">Give every due date a name, a date and a minimum amount (0 is allowed).</span>}
          {dirty && !missing && <span className="text-sm text-muted-foreground">Not saved yet. Class fees are not changed.</span>}
        </div>
      )}

      {d.instalments.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b p-4">
            <h3 className="flex items-center gap-2 font-semibold"><CalendarClock className="size-4 text-muted-foreground" /> 3. Who has not paid on time · late fees</h3>
            <p className="text-sm text-muted-foreground">After a due date, the Headmaster can charge a late fee to the students who have paid less than what was due by that date. A late fee can be removed later for one student, with a reason.</p>
          </div>
          <Table>
            <THead><TR><TH>Due date</TH><TH>On or before</TH><TH className="text-right">Students short</TH><TH className="text-right">Amount short</TH><TH className="text-right">Late fees charged</TH><TH /></TR></THead>
            <TBody>
              {d.instalments.map((i) => (
                <TR key={i.id}>
                  <TD className="font-medium">{i.label}<span className="block text-xs font-normal text-muted-foreground">minimum {rupees(i.amount)}</span></TD>
                  <TD className="whitespace-nowrap">{formatDate(i.dueOn)}{i.overdue ? <Badge variant="destructive" className="ml-2">Passed</Badge> : <Badge variant="secondary" className="ml-2">Upcoming</Badge>}</TD>
                  <TD className="text-right tabular-nums">{i.unpaidStudents}</TD>
                  <TD className="text-right tabular-nums">{rupees(i.unpaidAmount)}</TD>
                  <TD className="text-right tabular-nums">{i.penalties ? `${i.penalties} · ${rupees(i.penaltyAmount)}` : '—'}</TD>
                  <TD className="text-right whitespace-nowrap">
                    {i.unpaidStudents > 0 && <Button size="sm" variant={i.overdue && d.can.penalty ? 'default' : 'outline'} onClick={() => setPenaltyFor(i)}>{i.overdue && d.can.penalty ? 'Late fee…' : 'See list'}</Button>}
                    {i.penalties > 0 && d.can.penalty && <Button size="sm" variant="ghost" className="ml-1 text-destructive" onClick={() => setRemoveFor(i)}><Trash2 /> Remove late fees</Button>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {penaltyFor && <PenaltyDialog instalmentId={penaltyFor.id} canCharge={d.can.penalty} onClose={() => setPenaltyFor(null)} />}
      {removeFor && <RemoveAllDialog i={removeFor} onClose={() => setRemoveFor(null)} />}
    </>
  );
}

function RemoveAllDialog({ i, onClose }: { i: PlanView['instalments'][number]; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const save = useSave(() => api.post<{ removed: number }>(`/fees/instalments/${i.id}/penalty/waive-all`, { reason }), {
    invalidate: [['fees']], onSuccess: (r) => { toast.success(`Late fee removed for ${r.removed} students`); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Remove the late fees of ${i.label}?`} description={`The late fee is removed for all ${i.penalties} students (${rupees(i.penaltyAmount)} in all), and their balances go down. It stays in each student's record as removed, with your reason. You can charge it again afterwards, e.g. with the right amount.`}>
        <Field label="Reason" htmlFor="rar" required><Input id="rar" autoFocus placeholder="e.g. Charged the wrong amount / school extended the date" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="destructive" loading={save.isPending} disabled={reason.trim().length < 3} onClick={() => save.mutate(undefined)}><Trash2 /> Remove for all {i.penalties} students</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AmountInput({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div className="relative ml-auto w-28">
      <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
      <Input aria-label={label} inputMode="decimal" placeholder={placeholder} className="h-8 pl-5 text-right tabular-nums" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} />
    </div>
  );
}

// ======================================================================= late fee for one due date (Headmaster)

interface Defaulters {
  instalment: { id: number; label: string; dueOn: string; overdue: boolean };
  year: { id: number; name: string };
  rows: { ledgerId: number; studentId: number; fullName: string; rollNo: number | null; provisional: boolean; className: string; due: number; paid: number; balance: number; penalty: { id: number; amount: number; status: string } | null }[];
}

function PenaltyDialog({ instalmentId, canCharge, onClose }: { instalmentId: number; canCharge: boolean; onClose: () => void }) {
  const q = useQuery({ queryKey: ['fees', 'defaulters', instalmentId], queryFn: () => api.get<Defaulters>(`/fees/instalments/${instalmentId}/defaulters`) });
  const [amount, setAmount] = useState('');
  const [off, setOff] = useState<Set<number>>(new Set()); // new students unticked
  const [again, setAgain] = useState<Set<number>>(new Set()); // removed late fees ticked to charge again
  const chosen = useMemo(() => (q.data?.rows ?? []).filter((r) => (!r.penalty && !off.has(r.ledgerId)) || (r.penalty?.status === 'WAIVED' && again.has(r.ledgerId))), [q.data, off, again]);
  const charging = canCharge && !!q.data?.instalment.overdue;
  const save = useSave(() => api.post<{ charged: number; total: number }>(`/fees/instalments/${instalmentId}/penalty`, { amount: Number(amount), ledgerIds: chosen.map((r) => r.ledgerId) }), {
    invalidate: [['fees']], onSuccess: (r) => { toast.success(`Late fee charged to ${r.charged} students (${rupees(r.total)} in all)`); onClose(); },
  });
  const flip = (set: typeof setOff) => (id: number) => set((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggle = flip(setOff);
  const toggleAgain = flip(setAgain);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl" title={q.data ? `${q.data.instalment.label} · paid less than due` : 'Students who have not paid on time'}
        description={q.data ? `Due on ${formatDate(q.data.instalment.dueOn)} (${q.data.year.name}). ${charging ? 'Untick anyone who should not be charged. Each student is charged once per due date.' : q.data.instalment.overdue ? 'Only the Headmaster can charge a late fee.' : 'A late fee can be charged only after the due date.'}` : undefined}>
        <QueryView query={q}>
          {(d) => (
            <div className="grid gap-4">
              {charging && (
                <Field label="Late fee per student (₹)" htmlFor="pa" required><Input id="pa" inputMode="decimal" autoFocus className="w-40" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="e.g. 100" /></Field>
              )}
              {d.rows.length ? (
                <div className="max-h-[50vh] overflow-y-auto rounded-lg border">
                  <Table>
                    <THead><TR>{charging && <TH className="w-8" />}<TH>Student</TH><TH>Class</TH><TH className="text-right">Due by then</TH><TH className="text-right">Paid</TH><TH className="text-right">Short</TH><TH>Late fee</TH></TR></THead>
                    <TBody>
                      {d.rows.map((r) => (
                        <TR key={r.ledgerId}>
                          {charging && <TD>{!r.penalty ? <Checkbox aria-label={`Charge ${r.fullName}`} checked={!off.has(r.ledgerId)} onChange={() => toggle(r.ledgerId)} />
                            : r.penalty.status === 'WAIVED' && <Checkbox aria-label={`Charge ${r.fullName} again`} title="Late fee was removed: tick to charge again" checked={again.has(r.ledgerId)} onChange={() => toggleAgain(r.ledgerId)} />}</TD>}
                          <TD className="font-medium">{r.fullName}{r.provisional && <Badge variant="warning" className="ml-1.5">Provisional</Badge>}</TD>
                          <TD className="whitespace-nowrap text-sm">{r.className}<span className="block text-xs text-muted-foreground">Roll {r.rollNo ?? '—'}</span></TD>
                          <TD className="text-right tabular-nums">{rupees(r.due)}</TD>
                          <TD className="text-right tabular-nums text-emerald-700">{rupees(r.paid)}</TD>
                          <TD className="text-right font-semibold tabular-nums">{rupees(r.balance)}</TD>
                          <TD className="text-sm">{r.penalty ? (r.penalty.status === 'ACTIVE' ? <Badge variant="destructive">{rupees(r.penalty.amount)} charged</Badge> : <Badge variant="secondary">Removed{charging ? ' · tick to charge again' : ''}</Badge>) : '—'}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              ) : <EmptyState title="Everyone has paid what was due by this date" />}
            </div>
          )}
        </QueryView>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {charging && <Button loading={save.isPending} disabled={!(Number(amount) > 0) || !chosen.length} onClick={() => save.mutate(undefined)}><AlertTriangle /> Charge {Number(amount) > 0 ? rupees(Number(amount)) : 'late fee'} to {chosen.length} students</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= one student's due dates (student Fees tab and the fee ledger page)

export interface StudentInstalments {
  instalments: { lines: InstalmentLine[]; penaltyTotal: number; penaltyPaid: number; penaltyDue: number } | null;
  penalties: { id: number; instalment: string; amount: number; status: string; waiveReason: string | null; createdAt: string; waivedAt: string | null }[];
  ledger: { canWaive?: boolean };
}

const STATUS_BADGE: Record<InstalmentStatus, 'success' | 'warning' | 'secondary' | 'destructive'> = { PAID: 'success', PART_PAID: 'warning', DUE: 'secondary', OVERDUE: 'destructive' };

export function InstalmentsCard({ a }: { a: StudentInstalments }) {
  const [waive, setWaive] = useState<StudentInstalments['penalties'][number] | null>(null);
  if (!a.instalments && !a.penalties.length) return null;
  return (
    <Card className="overflow-hidden">
      <div className="border-b px-5 py-3 font-semibold">Fee due dates</div>
      {a.instalments && (
        <Table>
          <THead><TR><TH>Due date</TH><TH>On or before</TH><TH className="text-right">Amount due</TH><TH className="text-right">Paid</TH><TH className="text-right">Short</TH><TH>Status</TH></TR></THead>
          <TBody>
            {a.instalments.lines.map((l) => (
              <TR key={l.id}>
                <TD className="font-medium">{l.label}{l.previous > 0 && <span className="block text-xs font-normal text-muted-foreground">includes {rupees(l.previous)} from last year</span>}</TD>
                <TD className="whitespace-nowrap">{formatDate(l.dueOn)}</TD>
                <TD className="text-right tabular-nums">{rupees(l.total)}</TD>
                <TD className="text-right tabular-nums text-emerald-700">{l.paid ? rupees(l.paid) : '—'}</TD>
                <TD className="text-right font-semibold tabular-nums">{l.balance > 0 ? rupees(l.balance) : '—'}</TD>
                <TD><Badge variant={STATUS_BADGE[l.status]}>{INSTALMENT_STATUS_LABELS[l.status]}</Badge></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {a.penalties.length > 0 && (
        <ul className="divide-y border-t">
          {a.penalties.map((p) => (
            <li key={p.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm', p.status !== 'ACTIVE' && 'text-muted-foreground')}>
              <span className="min-w-0 flex-1">
                Late fee · {p.instalment} <span className="text-xs text-muted-foreground">({formatDate(p.createdAt)})</span>
                {p.status !== 'ACTIVE' && <span className="block text-xs">Removed{p.waivedAt ? ` on ${formatDate(p.waivedAt)}` : ''}: {p.waiveReason}</span>}
              </span>
              <span className={cn('tabular-nums', p.status === 'ACTIVE' ? 'font-semibold text-red-700' : 'line-through')}>{rupees(p.amount)}</span>
              {p.status === 'ACTIVE' && a.ledger.canWaive && <Button size="sm" variant="ghost" onClick={() => setWaive(p)}>Remove</Button>}
            </li>
          ))}
        </ul>
      )}
      {waive && <WaiveDialog p={waive} onClose={() => setWaive(null)} />}
    </Card>
  );
}

function WaiveDialog({ p, onClose }: { p: StudentInstalments['penalties'][number]; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const save = useSave(() => api.post(`/fees/penalties/${p.id}/waive`, { reason }), { invalidate: [['fees']], success: 'Late fee removed', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Remove the late fee of ${rupees(p.amount)}?`} description={`${p.instalment}. The student's balance goes down by ${rupees(p.amount)}. The late fee stays in the record as removed, with your reason.`}>
        <Field label="Reason" htmlFor="wr" required><Input id="wr" autoFocus placeholder="e.g. Parent was in hospital" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={reason.trim().length < 3} onClick={() => save.mutate(undefined)}>Remove late fee</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
