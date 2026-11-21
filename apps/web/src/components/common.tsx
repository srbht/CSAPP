import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import * as React from 'react';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter } from './ui/overlay';
import { Badge, Skeleton } from './ui/misc';

export function PageHeader({ title, description, actions, children, icon: Icon }: { title: string; description?: string; actions?: React.ReactNode; children?: React.ReactNode; icon?: React.ElementType }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {Icon && <div className="mt-0.5 hidden size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary sm:grid"><Icon className="size-5" /></div>}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
          {children}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, description, action, icon: Icon = Inbox }: { title: string; description?: string; action?: React.ReactNode; icon?: React.ElementType }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="mb-1 rounded-full bg-muted p-3 text-muted-foreground"><Icon className="size-6" /></div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const msg = error instanceof ApiError ? error.message : 'Something went wrong.';
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center" role="alert">
      <AlertTriangle className="size-6 text-destructive" />
      <p className="text-sm">{msg}</p>
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>{t('common.retry')}</Button>}
    </div>
  );
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
    </div>
  );
}

/** Loading / error / empty / data in one place so every list behaves the same way. */
export function QueryView<T>({ query, empty, children }: {
  query: { data: T | undefined; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  empty?: (d: T) => React.ReactNode | null;
  children: (d: T) => React.ReactNode;
}) {
  if (query.isPending) return <LoadingRows />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const d = query.data as T;
  const e = empty?.(d);
  return <>{e ?? children(d)}</>;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 border-t px-3 py-2.5 text-sm text-muted-foreground">
      <span>{from}–{to} of {total}</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('common.previous')}><ChevronLeft /></Button>
        <span className="px-1">{page} / {pages}</span>
        <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('common.next')}><ChevronRight /></Button>
      </div>
    </div>
  );
}

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'destructive' | 'default'> = {
  ACTIVE: 'success', INACTIVE: 'secondary', DISABLED: 'destructive', PLANNED: 'warning', CLOSED: 'secondary',
};
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const label = status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
  return <Badge variant={STATUS_VARIANT[status] ?? 'default'} className={className}>{label}</Badge>;
}

/** Confirmation for actions that are hard to undo. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', destructive, onConfirm, loading }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; confirmLabel?: string;
  destructive?: boolean; onConfirm: () => void; loading?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant={destructive ? 'destructive' : 'default'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Put server-side field errors (422/409) onto the form; return true when handled. */
export function applyServerErrors<T extends FieldValues>(err: unknown, setError: UseFormSetError<T>, fields: string[]): boolean {
  if (!(err instanceof ApiError)) return false;
  let applied = false;
  for (const e of err.errors) {
    const root = e.path.split('.')[0];
    if (fields.includes(e.path) || fields.includes(root)) {
      setError((fields.includes(e.path) ? e.path : root) as Path<T>, { message: e.message });
      applied = true;
    }
  }
  return applied;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const extra = err.errors.length ? ` ${err.errors.map((e) => e.message).filter((m) => m !== err.message).slice(0, 3).join(' · ')}` : '';
    return `${err.message}${extra}`.trim();
  }
  return 'Something went wrong. Please try again.';
}

/** Mutation with toast feedback and cache invalidation. */
export function useSave<TVars, TResult = unknown>(fn: (v: TVars) => Promise<TResult>, opts: { invalidate: QueryKey[]; success?: string; onSuccess?: (r: TResult) => void; onError?: (e: unknown) => boolean | void }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r) => {
      await Promise.all(opts.invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
      if (opts.success) toast.success(opts.success);
      opts.onSuccess?.(r);
    },
    onError: (e) => {
      if (opts.onError?.(e) === true) return;
      toast.error(errorMessage(e));
    },
  });
}

export function Section({ title, description, children, className, actions }: { title: string; description?: string; children: React.ReactNode; className?: string; actions?: React.ReactNode }) {
  return (
    <section className={cn('rounded-2xl border border-border/80 bg-card shadow-card', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-5 py-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
