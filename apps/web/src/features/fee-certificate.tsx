import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, rupees } from '@cps/shared';
import { ArrowLeft, FileBadge, Printer } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryView, useSave } from '@/components/common';
import { useSchoolLogo } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/form-controls';
import { Card } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { StudentDetail } from '@/lib/types';
import { formatDate, formatDateTime } from '@/lib/utils';

const P = PERMISSIONS;

interface Certificate {
  id: number; certificateNo: string; issuedAt: string; issuedBy: string | null;
  student: { id: number; fullName: string; gender: 'MALE' | 'FEMALE' | 'OTHER'; grNo: string; studentCode: string }; className: string; mediumName: string;
  breakdown: { concession: number; paid: number; balance: number; balanceInWords: string } | null;
  yearName: string; currentYear: boolean; amount: number; amountInWords: string;
  school: { name: string; nameHi: string | null; address: string; phone: string | null; email: string | null; udiseCode: string | null; principalTitle: string | null; principalName: string | null };
}

/** "Fee certificate" button on the student profile: choose the year, issue, print. */
export function FeeCertificateButton({ s }: { s: StudentDetail }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can(P.CERTIFICATES_ISSUE) || s.status === 'PENDING_APPROVAL' || s.status === 'REJECTED') return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><FileBadge /> Fee certificate</Button>
      {open && <IssueDialog s={s} onClose={() => setOpen(false)} />}
    </>
  );
}

function IssueDialog({ s, onClose }: { s: StudentDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const years = s.enrollments.filter((e) => e.status !== 'PENDING_APPROVAL' && e.status !== 'REJECTED');
  const [yearId, setYearId] = useState(String(s.current.academicYear.id));
  const issue = useSave(() => api.post<{ id: number }>('/fees/certificates', { studentId: s.id, academicYearId: Number(yearId) }), {
    invalidate: [['fee-certificates']], success: 'Fee certificate issued', onSuccess: (r) => navigate(`/fees/certificates/${r.id}`),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Fee certificate" description={`A letter for the parent of ${s.fullName} with the annual fee of the class. It gets a certificate number and is kept in the register.`}>
        <Field label="Academic year" htmlFor="fcy">
          <Select id="fcy" value={yearId} onChange={(e) => setYearId(e.target.value)}>
            {years.map((e) => <option key={e.academicYear.id} value={e.academicYear.id}>{e.academicYear.name} · {e.section.schoolClass.displayName} {e.section.name}</option>)}
          </Select>
        </Field>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={issue.isPending} onClick={() => issue.mutate(undefined)}><Printer /> Issue and print</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Certificates already issued to this student (reprint from here). */
export function FeeCertificatesList({ studentId }: { studentId: number }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['fee-certificates', studentId], queryFn: () => api.get<{ id: number; certificateNo: string; yearName: string; className: string; amount: number; issuedAt: string; issuedBy: string | null }[]>(`/fees/students/${studentId}/certificates`), enabled: can(P.CERTIFICATES_ISSUE) });
  if (!q.data?.length) return null;
  return (
    <Card className="p-4">
      <h3 className="mb-2 text-sm font-semibold">Fee certificates issued</h3>
      <ul className="divide-y text-sm">
        {q.data.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
            <Link to={`/fees/certificates/${c.id}`} className="font-mono font-medium text-primary hover:underline">{c.certificateNo}</Link>
            <span>{c.yearName} · {c.className} · {rupees(c.amount)}</span>
            <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(c.issuedAt)}{c.issuedBy ? ` · ${c.issuedBy}` : ''}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The printed letter (A4), as the school gives it to parents. */
export function FeeCertificatePage() {
  const { id } = useParams();
  const logo = useSchoolLogo();
  const q = useQuery({ queryKey: ['fee-certificate', id], queryFn: () => api.get<Certificate>(`/fees/certificates/${id}`) });
  return (
    <>
      <div className="mb-4 flex items-center gap-2 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => history.back()}><ArrowLeft /> Back</Button>
        <Button size="sm" className="ml-auto" onClick={() => window.print()}><Printer /> Print certificate</Button>
      </div>
      <QueryView query={q}>
        {(c) => {
          const his = c.student.gender === 'FEMALE' ? 'Her' : c.student.gender === 'MALE' ? 'His' : 'Their';
          const toWords = (w: string) => w.replace(/ Rupees( and .*)? Only$/, (_m, paise) => (paise ? ` Rupees${paise}` : ''));
          const words = toWords(c.amountInWords);
          const money = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2 });
          const sc = c.school;
          return (
            <div className="mx-auto max-w-[210mm] bg-white p-[14mm] text-[14px] leading-relaxed text-black shadow-card print:max-w-none print:p-0 print:shadow-none">
              <style>{'@page { size: A4; margin: 15mm; }'}</style>
              <header className="flex items-center gap-4 border-b-2 border-black pb-3">
                {logo.data ? <img src={logo.data} alt="" className="h-20 w-24 object-contain" /> : <div className="w-24" />}
                <div className="flex-1 text-center">
                  <h1 className="text-2xl font-bold" style={{ fontFamily: 'Georgia, serif' }}>{sc.name}</h1>
                  <p className="text-xs">{sc.address}</p>
                  <p className="text-xs">{[sc.phone && `Phone: ${sc.phone}`, sc.email, sc.udiseCode && `UDISE: ${sc.udiseCode}`].filter(Boolean).join(' · ')}</p>
                </div>
                <div className="w-24" />
              </header>
              <div className="mt-4 flex justify-between text-sm">
                <p>No.: <b className="font-mono">{c.certificateNo}</b></p>
                <p>Date: <b>{formatDate(c.issuedAt)}</b></p>
              </div>
              <h2 className="mt-6 text-center text-lg font-bold tracking-widest underline underline-offset-4">FEE CERTIFICATE</h2>
              <p className="mt-6 font-semibold">To whom so ever it may concern</p>
              <p className="mt-4 text-justify">
                This is to certify that <b>{c.student.fullName}</b> (Student ID {c.student.studentCode}{c.student.grNo ? `, G.R. No. ${c.student.grNo}` : ''}) {c.currentYear ? 'is studying' : 'was studying'} in <b>{c.className}</b> in our <b>{c.mediumName}</b> section.
                {' '}{his} fee details for the Academic Year <b>{c.yearName}</b> are given as under.
              </p>
              <table className="mt-5 w-full border-collapse">
                <thead><tr><th className="border border-black px-3 py-2 text-left">Particular</th><th className="w-48 border border-black px-3 py-2 text-right">Amount (₹)</th></tr></thead>
                <tbody>
                  <tr><td className="border border-black px-3 py-2">Annual fees ({c.className}, {c.mediumName}, {c.yearName})</td><td className="border border-black px-3 py-2 text-right tabular-nums">{c.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td></tr>
                  {c.breakdown && c.breakdown.concession > 0 && <tr><td className="border border-black px-3 py-2">Less: concession</td><td className="border border-black px-3 py-2 text-right tabular-nums">− {money(c.breakdown.concession)}</td></tr>}
                  {c.breakdown && <tr><td className="border border-black px-3 py-2">Less: fees already paid (till {formatDate(c.issuedAt)})</td><td className="border border-black px-3 py-2 text-right tabular-nums">− {money(c.breakdown.paid)}</td></tr>}
                  <tr className="font-bold"><td className="border border-black px-3 py-2 text-right">{c.breakdown ? 'Total (balance fees to be paid)' : 'Total'}</td><td className="border border-black px-3 py-2 text-right tabular-nums">{money(c.breakdown ? c.breakdown.balance : c.amount)}</td></tr>
                </tbody>
              </table>
              <p className="mt-3"><b>Total Rs. {c.breakdown ? toWords(c.breakdown.balanceInWords) : words} Only</b>{c.breakdown && c.breakdown.balance === 0 ? ' (the fees for this year are fully paid)' : ''}</p>
              <p className="mt-5 text-justify">The cheque should be issued in favour of <b>{sc.name}, {c.mediumName}</b>.</p>
              <p className="mt-2">This letter is issued on the request of the parent.</p>
              <div className="mt-20 flex items-end justify-between">
                <div className="grid size-28 place-items-center rounded-full border border-dashed border-gray-400 text-xs text-gray-400">School stamp</div>
                <div className="text-center">
                  <p className="w-56 border-t border-black pt-1 font-semibold">{sc.principalTitle ?? 'Headmaster'}</p>
                  {sc.principalName && <p className="text-sm">{sc.principalName}</p>}
                  <p className="text-sm">{sc.name}</p>
                </div>
              </div>
              <p className="mt-10 text-[10px] text-gray-500">Issued by {c.issuedBy ?? '—'} on {formatDateTime(c.issuedAt)} · Certificate {c.certificateNo}</p>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}
