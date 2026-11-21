import { useQuery } from '@tanstack/react-query';
import { ADMISSION_DOCUMENTS, CATEGORY_SUGGESTIONS, dateInWords, GENDER_LABELS, grNoLabel } from '@cps/shared';
import { ArrowLeft, Download, Eye, FileText, Printer, Trash2 } from 'lucide-react';
import { Fragment } from 'react';
import { useParams } from 'react-router';
import { toast } from 'sonner';
import { errorMessage, QueryView, useSave } from '@/components/common';
import { useSchoolLogo } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { School, StudentDetail, StudentDocumentFile } from '@/lib/types';
import { formatDate } from '@/lib/utils';

// ======================================================================= document scans (form + profile)

export const ACCEPT_DOCUMENTS = 'application/pdf,image/jpeg,image/png,image/webp';
export const ACCEPT_PHOTO = 'image/jpeg,image/png,image/webp';

export function fileSize(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Opens (or downloads) any protected file from the API: fetched with the sign-in token, then shown from a blob URL. */
export async function openBlob(path: string, download?: string) {
  try {
    const blob = await api.get<Blob>(path);
    const url = URL.createObjectURL(blob);
    if (download) {
      const a = document.createElement('a');
      a.href = url;
      a.download = download;
      a.click();
    } else {
      window.open(url, '_blank', 'noopener');
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

/** Opens a scan in a new tab (the API needs the sign-in token, so it is fetched as a blob first). */
export async function openDocument(studentId: number, docId: number, download?: string) {
  const blob = await api.get<Blob>(`/students/${studentId}/documents/${docId}`);
  const url = URL.createObjectURL(blob);
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = download;
    a.click();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Uploaded scans for one document type, with view / download / remove. */
export function UploadedFiles({ studentId, files, canDelete }: { studentId: number; files: StudentDocumentFile[]; canDelete: boolean }) {
  const remove = useSave((docId: number) => api.delete(`/students/${studentId}/documents/${docId}`), { invalidate: [['students']], success: 'Document removed' });
  if (!files.length) return null;
  return (
    <ul className="grid gap-1">
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-1.5 text-xs">
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <button type="button" className="min-w-0 truncate text-left text-primary hover:underline" title={`View ${f.fileName}`} onClick={() => void openDocument(studentId, f.id)}>{f.fileName}</button>
          <span className="shrink-0 text-muted-foreground">{fileSize(f.sizeBytes)}</span>
          <button type="button" className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-muted" aria-label={`View ${f.fileName}`} title="View" onClick={() => void openDocument(studentId, f.id)}><Eye className="size-3.5" /></button>
          <button type="button" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted" aria-label={`Download ${f.fileName}`} title="Download" onClick={() => void openDocument(studentId, f.id, f.fileName)}><Download className="size-3.5" /></button>
          {canDelete && (
            <button type="button" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Remove ${f.fileName}`} title="Remove"
              onClick={() => { if (confirm(`Remove "${f.fileName}" from ${f.docType}?`)) remove.mutate(f.id); }}><Trash2 className="size-3.5" /></button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ======================================================================= printable admission form

/** Filled form for one student: /students/:id/admission-form */
export function AdmissionFormPrintPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['students', 'detail', id], queryFn: () => api.get<StudentDetail>(`/students/${id}`) });
  return <QueryView query={q}>{(s) => <AdmissionFormPrint s={s} />}</QueryView>;
}

/** Empty form for parents to fill by hand: /students/admission-form/blank */
export function BlankAdmissionFormPage() {
  return <AdmissionFormPrint />;
}

function AdmissionFormPrint({ s }: { s?: StudentDetail }) {
  const school = useQuery({ queryKey: ['school'], queryFn: () => api.get<School>('/school') });
  const logo = useSchoolLogo();
  const photo = useQuery({
    queryKey: ['student-photo', s?.id, s?.photoFileId],
    queryFn: async () => URL.createObjectURL(await api.get<Blob>(`/students/${s!.id}/photo`)),
    enabled: !!s?.photoFileId,
    staleTime: Infinity,
  });
  const blank = !s;
  const g = (rel: string) => s?.guardians.find((x) => x.relation === rel);
  const other = s?.guardians.find((x) => x.relation === 'GUARDIAN' || x.relation === 'OTHER');
  const v = (x: unknown) => (blank || x === null || x === undefined || x === '' ? '' : String(x));
  const d = (x: string | null | undefined) => (x ? formatDate(x) : '');
  const yes = (x: boolean | null | undefined) => (blank || x === null || x === undefined ? null : x);
  const sc = school.data;
  const received = new Set(s?.documents ?? []);
  const cls = s ? `${s.current.section.schoolClass.displayName} – ${s.current.section.name}` : '';
  const medium = s?.current.section.schoolClass.medium.nameEn ?? '';

  return (
    <>
      <style>{'@page { size: A4; margin: 10mm; } @media print { html, body { background: #fff !important; } }'}</style>
      <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => history.back()}><ArrowLeft /> Back</Button>
        <p className="text-sm text-muted-foreground">{blank ? 'Blank admission form for parents to fill by hand.' : `Admission form of ${s.fullName}.`} Prints on A4 paper (2 pages).</p>
        <Button size="sm" className="ml-auto" onClick={() => window.print()}><Printer /> Print</Button>
      </div>

      <div className="mx-auto max-w-[210mm] bg-white p-[8mm] text-[12px] leading-snug text-black shadow-card print:max-w-none print:p-0 print:shadow-none">
        {/* Header */}
        <header className="flex items-center gap-3 border-b-2 border-black pb-2">
          {logo.data ? <img src={logo.data} alt="" className="h-16 w-20 object-contain" /> : <div className="w-20" />}
          <div className="flex-1 text-center">
            <h1 className="text-xl font-bold" style={{ fontFamily: 'Georgia, serif' }}>{sc?.name ?? ''}</h1>
            <p className="text-[11px]">{[sc?.addressLine, sc?.city, sc?.pincode].filter(Boolean).join(', ')}{sc?.phone ? ` · ☎ ${sc.phone}` : ''}</p>
            <p className="text-[11px]">{[sc?.udiseCode && `UDISE: ${sc.udiseCode}`, sc?.registrationNo && `Reg. No: ${sc.registrationNo}`, sc?.board].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="w-20" />
        </header>

        <div className="mt-2 flex items-start gap-3">
          <div className="flex-1">
            <h2 className="text-center text-base font-bold tracking-wide">ADMISSION FORM</h2>
            <table className="mt-2 w-full border-collapse">
              <tbody>
                <tr>
                  <Cell label="Form No." value={v(s?.admissionFormNo)} />
                  <Cell label="Student ID" value={v(s?.studentCode)} />
                </tr>
                <tr>
                  <Cell label="Academic year" value={v(s?.current.academicYear.name)} />
                  <Cell label="Admission date" value={d(s?.admissionDate)} />
                </tr>
                <tr>
                  <Cell label="Class & division" value={cls} />
                  <Cell label="Medium" value={medium} choices={blank ? ['English', 'Hindi'] : undefined} />
                </tr>
                <tr>
                  <Cell label="G.R. No." value={s ? grNoLabel(s) : ''} />
                  <Cell label="Roll No / Exam No" value={s ? [s.current.rollNo, s.current.examNo].filter(Boolean).join(' / ') : ''} />
                </tr>
                <tr>
                  <Cell label="Admission type" value={s ? (s.isRte ? 'RTE (25 % quota)' : 'Regular') : ''} choices={blank ? ['Regular', 'RTE (25 %)'] : undefined} />
                  <Cell label="Comes to school by" value={v(s?.transportMode)} />
                </tr>
              </tbody>
            </table>
          </div>
          <div className="grid h-[42mm] w-[34mm] shrink-0 place-items-center overflow-hidden border border-black text-center text-[10px] text-gray-500">
            {photo.data ? <img src={photo.data} alt="" className="size-full object-cover" /> : <span>Paste recent<br />passport-size photo</span>}
          </div>
        </div>

        <Section title="1. Student details">
          <tr><Cell span={2} label="Full name (Surname First Father Mother)" value={v(s?.fullName)} tall /></tr>
          <tr>
            <Cell label="Gender" value={s ? GENDER_LABELS[s.gender] : ''} choices={blank ? ['Male', 'Female', 'Other'] : undefined} />
            <Cell label="Date of birth" value={d(s?.dob)} />
          </tr>
          <tr><Cell span={2} label="Date of birth in words" value={s ? dateInWords(s.dob) : ''} tall /></tr>
          <tr>
            <Cell label="Place of birth" value={v(s?.birthPlace)} />
            <Cell label="Nationality" value={v(s?.nationality)} />
          </tr>
          <tr>
            <Cell label="Mother tongue" value={v(s?.motherTongue)} />
            <Cell label="Blood group" value={v(s?.bloodGroup)} />
          </tr>
        </Section>

        <Section title="2. Previous school">
          <tr><Cell span={2} label="Name of previous school" value={v(s?.previousSchool)} tall /></tr>
          <tr>
            <Cell label="Std Passed" value={v(s?.previousClass)} />
            <Cell label="Last Std Passed Year" value={v(s?.previousSchoolYear)} />
          </tr>
          <tr>
            <Cell span={2} label="LC / TC No. and date" value={s ? [s.previousLcNo, d(s.previousLcDate)].filter(Boolean).join(' · ') : ''} />
          </tr>
        </Section>

        <Section title="3. Parents / guardian">
          <tr className="bg-gray-100 text-[11px]">
            <th className="w-[28%] border border-black px-1.5 py-1 text-left" />
            <th className="border border-black px-1.5 py-1 text-left">Father</th>
            <th className="border border-black px-1.5 py-1 text-left">Mother</th>
            <th className="border border-black px-1.5 py-1 text-left">Guardian</th>
          </tr>
          {([
            ['Name', 'name'], ['Mobile', 'mobile'], ['WhatsApp', 'whatsapp'],
          ] as const).map(([en, k]) => (
            <tr key={k}>
              <td className="border border-black px-1.5 py-1 align-top text-[11px]">{en}</td>
              {[g('FATHER'), g('MOTHER'), other].map((p, i) => <td key={i} className="h-8 border border-black px-1.5 py-1 align-top font-semibold">{v(p?.[k])}</td>)}
            </tr>
          ))}
        </Section>

        <Section title="4. Government records">
          <tr>
            <Cell label="Religion" value={v(s?.religion)} />
            <Cell label="Category" value={v(s?.category)} choices={blank ? [...CATEGORY_SUGGESTIONS] : undefined} />
          </tr>
          <tr>
            <Cell label="Caste" value={v(s?.caste)} />
            <Cell label="Sub-caste" value={v(s?.subCaste)} />
          </tr>
          <tr>
            <Cell label="BPL family" value={yesNo(yes(s?.isBpl))} choices={blank ? ['Yes', 'No'] : undefined} />
            <Cell label="Minority" value={yesNo(yes(s?.isMinority))} choices={blank ? ['Yes', 'No'] : undefined} />
          </tr>
          <tr>
            <Cell label="Aadhaar No. (student)" value={s?.aadhaarLast4 ? `XXXX XXXX ${s.aadhaarLast4}` : ''} />
            <Cell label="PEN (UDISE+)" value={v(s?.pen)} />
          </tr>
          <tr>
            <Cell label="APAAR ID" value={v(s?.apaarId)} />
            <Cell label="Saral ID" value={v(s?.saralId)} />
          </tr>
        </Section>

        <Section title="5. Documents attached">
          <tr>
            <td colSpan={2} className="border border-black px-1.5 py-1.5">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {ADMISSION_DOCUMENTS.map((doc) => (
                  <span key={doc} className="flex items-center gap-1.5"><Box checked={received.has(doc)} /> {doc}</span>
                ))}
              </div>
            </td>
          </tr>
        </Section>

        <section className="mt-3 border border-black p-2">
          <h3 className="font-bold">Declaration by parent / guardian</h3>
          <p className="mt-1">I declare that the information given above is true and correct. I will follow the rules of the school and inform the school of any change in the details above.</p>
          <div className="mt-10 grid grid-cols-3 gap-6 text-center text-[11px]">
            <p className="border-t border-black pt-1">Date & place</p>
            <p className="border-t border-black pt-1">Name of parent</p>
            <p className="border-t border-black pt-1">Signature of parent</p>
          </div>
        </section>

        <section className="mt-3 border-2 border-dashed border-black p-2">
          <h3 className="font-bold">For office use only</h3>
          <table className="mt-1 w-full border-collapse">
            <tbody>
              <tr>
                <Cell label="Admitted to class & division" value={cls} />
                <Cell label="G.R. No." value={s ? grNoLabel(s) : ''} />
              </tr>
              <tr>
                <Cell label="Date of admission" value={d(s?.admissionDate)} />
                <Cell label="Fee receipt No." value="" />
              </tr>
              <tr>
                <Cell label="Student ID" value={v(s?.studentCode)} />
                <Cell label="Admission type" value={s ? (s.isRte ? 'RTE (25 % quota)' : 'Regular') : ''} choices={blank ? ['Regular', 'RTE (25 %)'] : undefined} />
              </tr>
            </tbody>
          </table>
          <div className="mt-10 grid grid-cols-2 gap-16 text-center text-[11px]">
            <p className="border-t border-black pt-1">Checked by (office)</p>
            <p className="border-t border-black pt-1">{sc?.principalTitle ?? 'Headmaster'}{sc?.principalName ? ` (${sc.principalName})` : ''}</p>
          </div>
        </section>
        {s && <p className="mt-2 text-right text-[10px] text-gray-500">Printed from the school ERP on {formatDate(new Date().toISOString())} · Student ID {s.studentCode}</p>}
      </div>
    </>
  );
}

function yesNo(x: boolean | null) {
  return x === null ? '' : x ? 'Yes' : 'No';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-3 break-inside-avoid">
      <h3 className="mb-1 bg-gray-200 px-1.5 py-0.5 font-bold print:bg-gray-200" style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }}>
        {title}
      </h3>
      <table className="w-full table-fixed border-collapse"><tbody>{children}</tbody></table>
    </section>
  );
}

function Cell({ label, value, span = 1, tall, rows = 1, choices, lang }: {
  label: React.ReactNode; value: string; span?: 1 | 2; tall?: boolean; rows?: number; choices?: string[]; lang?: string;
}) {
  return (
    <>
      <td className="w-[22%] border border-black px-1.5 py-1 align-top text-[11px]">{label}</td>
      <td colSpan={span === 2 ? 3 : 1} lang={lang} className="border border-black px-1.5 py-1 align-top font-semibold" style={{ height: tall || rows > 1 ? `${8 * rows}mm` : '8mm' }}>
        {choices
          ? <span className="flex flex-wrap gap-x-3 font-normal">{choices.map((c) => <Fragment key={c}><span className="flex items-center gap-1"><Box /> {c}</span></Fragment>)}</span>
          : value}
      </td>
    </>
  );
}

function Box({ checked }: { checked?: boolean }) {
  return <span className="inline-grid size-3.5 shrink-0 place-items-center border border-black text-[10px] leading-none">{checked ? '✓' : ''}</span>;
}
