import { useQuery } from '@tanstack/react-query';
import { PROGRESS_LABELS, type ProgressBucket } from '@cps/shared';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

/** One colour per step of the approval chain, used everywhere (chips, bars, legend). */
export const BUCKET_STYLE: Record<ProgressBucket, { chip: string; bar: string; short: string }> = {
  NOT_STARTED: { chip: 'bg-muted text-muted-foreground border-border', bar: 'bg-muted-foreground/25', short: 'Not started' },
  OPERATOR: { chip: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-800', bar: 'bg-sky-400', short: 'Entering' },
  CORRECTION: { chip: 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800', bar: 'bg-red-500', short: 'Correction' },
  SUBJECT_VERIFY: { chip: 'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800', bar: 'bg-amber-400', short: 'Subject teacher' },
  CLASS_APPROVE: { chip: 'bg-violet-50 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:border-violet-800', bar: 'bg-violet-500', short: 'Class teacher' },
  HEADMASTER_APPROVE: { chip: 'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-200 dark:border-indigo-800', bar: 'bg-indigo-600', short: 'Headmaster' },
  APPROVED: { chip: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800', bar: 'bg-emerald-500', short: 'Approved' },
};
export const BUCKET_ORDER: ProgressBucket[] = ['NOT_STARTED', 'OPERATOR', 'CORRECTION', 'SUBJECT_VERIFY', 'CLASS_APPROVE', 'HEADMASTER_APPROVE', 'APPROVED'];

export function BucketChip({ bucket, label, className }: { bucket: ProgressBucket; label?: string; className?: string }) {
  return <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', BUCKET_STYLE[bucket].chip, className)}>{label ?? PROGRESS_LABELS[bucket]}</span>;
}

/** Stacked bar of how many units are at each step. */
export function ProgressBar({ buckets, total, className }: { buckets: Record<ProgressBucket, number>; total: number; className?: string }) {
  if (!total) return null;
  return (
    <div className={cn('flex h-2 w-full overflow-hidden rounded-full bg-muted', className)} role="img" aria-label={BUCKET_ORDER.filter((b) => buckets[b]).map((b) => `${buckets[b]} ${PROGRESS_LABELS[b]}`).join(', ')}>
      {BUCKET_ORDER.map((b) => buckets[b] ? <div key={b} className={BUCKET_STYLE[b].bar} style={{ width: `${(buckets[b] / total) * 100}%` }} /> : null)}
    </div>
  );
}

export function BucketLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {BUCKET_ORDER.map((b) => <span key={b} className="inline-flex items-center gap-1.5"><span className={cn('size-2.5 rounded-sm', BUCKET_STYLE[b].bar)} />{PROGRESS_LABELS[b]}</span>)}
    </div>
  );
}

export type Unit = { recordType: 'MARKS'; examId: number; sectionId: number; classSubjectId: number } | { recordType: 'ATTENDANCE'; sectionId: number; period: string };
export const sheetHref = (u: Unit) => `/sheet?${new URLSearchParams(Object.entries(u).map(([k, v]) => [k, String(v)])).toString()}`;
export function SheetLink({ unit, children, className }: { unit: Unit; children: React.ReactNode; className?: string }) {
  return <Link to={sheetHref(unit)} className={className}>{children}</Link>;
}

export interface Tasks {
  review: number;
  corrections: number;
  items: {
    submissionId: number; recordType: 'MARKS' | 'ATTENDANCE'; stage: string; status: string; since: string; period: string | null; subject: string | null;
    exam: { id: number; code: string; nameEn: string } | null; section: { id: number; name: string; schoolClass: { displayName: string } }; unit: Unit;
  }[];
}
export function useTasks() {
  const { me } = useAuth();
  return useQuery({ queryKey: ['workflow', 'tasks'], queryFn: () => api.get<Tasks>('/workflow/tasks'), enabled: !!me, refetchInterval: 60_000 });
}

export interface Exam { id: number; code: string; nameEn: string; nameHi: string | null; kind: 'SEMESTER'; reportTerm: string | null; sequence: number; marksDueDate: string | null; status: string; subjectCount: number }
export function useExams() {
  const { me } = useAuth();
  const yearId = me?.preferences.academicYearId;
  return useQuery({ queryKey: ['exams', yearId], queryFn: () => api.get<Exam[]>(`/exams${yearId ? `?academicYearId=${yearId}` : ''}`), enabled: !!me });
}

export interface SummaryItem { key: string; label: string; classSubjectId?: number; examId?: number; period?: string; bucket: ProgressBucket; submissionId: number | null; mine: boolean }
export interface SummaryDivision {
  sectionId: number; name: string; total: number; myPending: number; buckets: Record<ProgressBucket, number>; items: SummaryItem[];
  schoolClass: { displayName: string; medium: { code: string; nameEn: string }; standard: { code: string; levelOrder: number } };
}
export interface Summary {
  year: { id: number; name: string }; scopeAll: boolean; exam?: { id: number; nameEn: string; code: string } | null; period?: string | null; months?: string[];
  divisions: SummaryDivision[]; totals: Record<ProgressBucket, number>; myPending: number;
}
