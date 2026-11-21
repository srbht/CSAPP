import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('rounded-2xl border border-border/80 bg-card text-card-foreground shadow-card', className)} {...props} />;
}
export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 px-5 pt-5', className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return <h3 className={cn('font-semibold leading-tight', className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}
export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-5 py-5', className)} {...props} />;
}

const badgeVariants = cva('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary/10 text-primary',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      success: 'border-transparent bg-success/12 text-success',
      warning: 'border-transparent bg-warning/15 text-[oklch(0.45_0.12_70)]',
      destructive: 'border-transparent bg-destructive/10 text-destructive',
      outline: 'text-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}
export const THead = (p: React.ComponentProps<'thead'>) => <thead className={cn('[&_tr]:border-b bg-muted/60', p.className)} {...p} />;
export const TBody = (p: React.ComponentProps<'tbody'>) => <tbody className={cn('[&_tr:last-child]:border-0', p.className)} {...p} />;
export const TR = ({ className, ...p }: React.ComponentProps<'tr'>) => <tr className={cn('border-b border-border/70 transition-colors hover:bg-primary/[0.03]', className)} {...p} />;
export const TH = ({ className, ...p }: React.ComponentProps<'th'>) => (
  <th className={cn('h-10 px-3 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap', className)} {...p} />
);
export const TD = ({ className, ...p }: React.ComponentProps<'td'>) => <td className={cn('px-3 py-3 align-middle', className)} {...p} />;
