import { useQuery } from '@tanstack/react-query';
import {
  PERMISSION_META, PERMISSIONS, resetPasswordSchema, SCOPE_TYPES, userCreateSchema, userUpdateSchema,
} from '@cps/shared';
import { KeyRound, LockOpen, Pencil, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { applyServerErrors, EmptyState, PageHeader, Pagination, QueryView, StatusBadge, useSave } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/form-controls';
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/overlay';
import { api, qs, type Page } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounced, useMediums, useWorkingContext } from '@/lib/hooks';
import type { AuditLog, Role, SchoolClass, Staff, User } from '@/lib/types';
import { cn, formatDateTime } from '@/lib/utils';
import { err, useZodForm } from './settings';

const P = PERMISSIONS;
const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label={placeholder} className="pl-8" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ======================================================================= Staff
export function UsersPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q);
  const list = useQuery({ queryKey: ['users', { search, page }], queryFn: () => api.get<Page<User>>(`/users${qs({ q: search, page, pageSize: 25 })}`), placeholderData: (p) => p });
  const [dlg, setDlg] = useState<User | 'new' | null>(null);
  const [reset, setReset] = useState<User | null>(null);
  const unlock = useSave((id: number) => api.post(`/users/${id}/unlock`), { invalidate: [['users']], success: 'Account unlocked' });
  return (
    <>
      <PageHeader
        title="Users"
        description="Logins for staff. Each login gets roles; teachers usually get the 'Assigned classes' scope so they only see their own divisions."
        actions={<><SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search username, mobile, name" /><Button onClick={() => setDlg('new')}><Plus /> Add user</Button></>}
      />
      <Card>
        <QueryView query={list} empty={(d) => (d.data.length ? null : <EmptyState title="No users found" />)}>
          {(d) => (
            <>
              <Table>
                <THead><TR><TH>Username</TH><TH>Staff</TH><TH>Roles</TH><TH>Last sign-in</TH><TH>Status</TH><TH /></TR></THead>
                <TBody>
                  {d.data.map((u) => {
                    const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
                    return (
                      <TR key={u.id}>
                        <TD className="font-medium">{u.username}{u.mobile && <span className="block text-xs text-muted-foreground">{u.mobile}</span>}</TD>
                        <TD>{u.staff?.name ?? '—'}</TD>
                        <TD><div className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r.id} variant="secondary">{r.role.name}{r.scopeType !== 'SCHOOL' ? ` · ${r.scopeType === 'ASSIGNED' ? 'assigned' : r.scopeType.toLowerCase()}` : ''}</Badge>)}</div></TD>
                        <TD className="text-muted-foreground">{formatDateTime(u.lastLoginAt)}</TD>
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            <StatusBadge status={u.status} />
                            {locked && <Badge variant="destructive">Locked</Badge>}
                            {u.mustChangePassword && <Badge variant="warning">Temp password</Badge>}
                          </div>
                        </TD>
                        <TD>
                          <div className="flex justify-end gap-1">
                            {locked && <Button size="sm" variant="outline" onClick={() => unlock.mutate(u.id)}><LockOpen /> Unlock</Button>}
                            <Button size="sm" variant="outline" onClick={() => setReset(u)} aria-label={`Reset password for ${u.username}`}><KeyRound /> Reset password</Button>
                            <Button size="sm" variant="ghost" onClick={() => setDlg(u)} aria-label={`Edit ${u.username}`}><Pencil /> Edit</Button>
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
              <Pagination page={d.meta.page} pageSize={d.meta.pageSize} total={d.meta.total} onPage={setPage} />
            </>
          )}
        </QueryView>
      </Card>
      {dlg && <UserDialog user={dlg === 'new' ? null : dlg} onClose={() => setDlg(null)} />}
      {reset && <ResetPasswordDialog user={reset} onClose={() => setReset(null)} />}
    </>
  );
}

interface Grant { roleId: number | ''; scopeType: (typeof SCOPE_TYPES)[number]; scopeId: number | null }
const SCOPE_LABEL: Record<string, string> = { SCHOOL: 'Whole school', MEDIUM: 'One medium', CLASS: 'One class', SECTION: 'One division', ASSIGNED: 'Assigned classes only' };

function UserDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const roles = useRoles();
  const mediums = useMediums();
  const ctx = useWorkingContext();
  const classes = useQuery({ queryKey: ['classes', ctx.yearId, ''], queryFn: () => api.get<SchoolClass[]>(`/classes${qs({ academicYearId: ctx.yearId })}`), enabled: !!ctx.yearId });
  const staff = useQuery({ queryKey: ['staff', 'active-all'], queryFn: () => api.get<Page<Staff>>('/staff?status=ACTIVE&pageSize=100&sort=name') });
  const [username, setUsername] = useState(user?.username ?? '');
  const [mobile, setMobile] = useState(user?.mobile ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [staffId, setStaffId] = useState<number | ''>(user?.staffId ?? '');
  const [status, setStatus] = useState<'ACTIVE' | 'DISABLED'>(user?.status ?? 'ACTIVE');
  const [password, setPassword] = useState('');
  const [grants, setGrants] = useState<Grant[]>(user?.roles.map((r) => ({ roleId: r.roleId, scopeType: r.scopeType as Grant['scopeType'], scopeId: r.scopeId })) ?? [{ roleId: '', scopeType: 'ASSIGNED', scopeId: null }]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useSave((body: object) => (user ? api.patch(`/users/${user.id}`, body) : api.post('/users', body)), {
    invalidate: [['users'], ['staff'], ['dashboard'], ['me']], success: user ? 'User saved' : 'User created. Share the temporary password privately.', onSuccess: onClose,
    onError: (e) => {
      const map: Record<string, string> = {};
      if (e && typeof e === 'object' && 'errors' in e) for (const fe of (e as { errors: { path: string; message: string }[] }).errors) map[fe.path.split('.').slice(0, 2).join('.')] = fe.message;
      setErrors(map);
      return false;
    },
  });

  const submit = () => {
    const body = {
      ...(user ? { status } : { username, temporaryPassword: password }),
      mobile, email, staffId: staffId === '' ? null : staffId,
      roles: grants.filter((g) => g.roleId !== '').map((g) => ({ roleId: g.roleId, scopeType: g.scopeType, scopeId: ['SCHOOL', 'ASSIGNED'].includes(g.scopeType) ? null : g.scopeId })),
    };
    const parsed = (user ? userUpdateSchema : userCreateSchema).safeParse(body);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.slice(0, 2).join('.'), i.message])));
      return;
    }
    setErrors({});
    save.mutate(body);
  };
  const setG = (i: number, patch: Partial<Grant>) => setGrants((g) => g.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const scopeTargets = (t: string) =>
    t === 'MEDIUM' ? mediums.data?.map((m) => ({ id: m.id, name: m.nameEn }))
      : t === 'CLASS' ? classes.data?.map((c) => ({ id: c.id, name: c.displayName }))
        : t === 'SECTION' ? classes.data?.flatMap((c) => c.sections.map((s) => ({ id: s.id, name: `${c.displayName}-${s.name}` })))
          : [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={user ? `Edit ${user.username}` : 'Add user'} description={user ? undefined : 'The person must change this temporary password at first sign-in.'} wide>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" htmlFor="un" required={!user} error={errors.username}><Input id="un" value={username} disabled={!!user} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></Field>
          <Field label="Linked staff member" htmlFor="ls" error={errors.staffId} hint="Required for teachers with 'Assigned classes' scope">
            <Select id="ls" value={staffId} onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">— None —</option>
              {staff.data?.data.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.employeeCode})</option>)}
            </Select>
          </Field>
          <Field label="Mobile (can be used to sign in)" htmlFor="um" error={errors.mobile}><Input id="um" inputMode="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} /></Field>
          <Field label="Email" htmlFor="ue" error={errors.email}><Input id="ue" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {user ? (
            <Field label="Status" htmlFor="ust"><Select id="ust" value={status} onChange={(e) => setStatus(e.target.value as 'ACTIVE')}><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option></Select></Field>
          ) : (
            <Field label="Temporary password" htmlFor="tp" required error={errors.temporaryPassword} hint="At least 8 characters, letters and numbers"><Input id="tp" type="text" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          )}
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Roles <span className="text-destructive">*</span></p>
          {errors.roles && <p className="mb-2 text-xs text-destructive">{errors.roles}</p>}
          <div className="grid gap-2">
            {grants.map((g, i) => {
              const targets = scopeTargets(g.scopeType);
              return (
                <div key={i} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <Select aria-label="Role" value={g.roleId} onChange={(e) => { const r = roles.data?.find((x) => x.id === Number(e.target.value)); setG(i, { roleId: e.target.value ? Number(e.target.value) : '', scopeType: (r?.defaultScope as Grant['scopeType']) ?? g.scopeType }); }}>
                    <option value="">Choose role…</option>{roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>
                  <Select aria-label="Scope" value={g.scopeType} onChange={(e) => setG(i, { scopeType: e.target.value as Grant['scopeType'], scopeId: null })}>
                    {SCOPE_TYPES.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                  </Select>
                  {targets && targets.length > 0 ? (
                    <Select aria-label="Scope target" value={g.scopeId ?? ''} onChange={(e) => setG(i, { scopeId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">Choose…</option>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                  ) : <div className="hidden sm:block" />}
                  <Button variant="ghost" size="icon" disabled={grants.length === 1} onClick={() => setGrants((x) => x.filter((_, j) => j !== i))} aria-label="Remove role"><Trash2 /></Button>
                  {errors[`roles.${i}`] && <p className="text-xs text-destructive sm:col-span-4">{errors[`roles.${i}`]}</p>}
                </div>
              );
            })}
          </div>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setGrants((g) => [...g, { roleId: '', scopeType: 'SCHOOL', scopeId: null }])}><Plus /> Add role</Button>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={submit}>{user ? 'Save' : 'Create user'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const form = useZodForm(resetPasswordSchema, { temporaryPassword: '' });
  const save = useSave((v: z.output<typeof resetPasswordSchema>) => api.post(`/users/${user.id}/reset-password`, v), {
    invalidate: [['users']], success: 'Password reset. The user must change it at next sign-in.', onSuccess: onClose,
    onError: (e) => applyServerErrors(e, form.setError, ['temporaryPassword']),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Reset password for ${user.username}`} description="All their devices will be signed out.">
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4" noValidate>
          <Field label="Temporary password" htmlFor="rtp" required error={err(form.formState.errors.temporaryPassword)}><Input id="rtp" autoComplete="new-password" {...form.register('temporaryPassword')} /></Field>
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Reset password</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= Roles & permissions
export function RolesPage() {
  const { can } = useAuth();
  const canEdit = can(P.ROLES_MANAGE);
  const roles = useRoles();
  const [dlg, setDlg] = useState<Role | 'new' | null>(null);
  const modules = [...new Set(PERMISSION_META.map((p) => p.module))];
  return (
    <>
      <PageHeader title="Roles & Permissions" description="What each role may do. Permissions are checked by the server on every request." actions={canEdit && <Button onClick={() => setDlg('new')}><Plus /> New role</Button>} />
      <QueryView query={roles}>
        {(list) => (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((r) => (
              <Card key={r.id} className="flex flex-col p-4">
                <div className="mb-2 flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 size-4 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{r.name}</p>
                    <p className="text-xs text-muted-foreground">{r.userCount} users · {r.code === 'SUPER_ADMIN' ? 'all permissions' : `${r.permissions.length} permissions`}{r.isSystem ? ' · built-in' : ''}</p>
                  </div>
                  {canEdit && r.code !== 'SUPER_ADMIN' && <Button size="sm" variant="ghost" onClick={() => setDlg(r)} aria-label={`Edit ${r.name}`}><Pencil /></Button>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {modules.filter((m) => r.code === 'SUPER_ADMIN' || PERMISSION_META.some((p) => p.module === m && r.permissions.includes(p.code))).map((m) => <Badge key={m} variant="outline">{m}</Badge>)}
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryView>
      {dlg && <RoleDialog role={dlg === 'new' ? null : dlg} onClose={() => setDlg(null)} />}
    </>
  );
}

function RoleDialog({ role, onClose }: { role: Role | null; onClose: () => void }) {
  const [code, setCode] = useState(role?.code ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const save = useSave((b: object) => (role ? api.patch(`/roles/${role.id}`, b) : api.post('/roles', b)), { invalidate: [['roles'], ['me']], success: 'Role saved', onSuccess: onClose });
  const modules = [...new Set(PERMISSION_META.map((p) => p.module))];
  const toggle = (c: string) => setPerms((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={role ? `Edit ${role.name}` : 'New role'} description="Changes apply immediately to everyone with this role." wide>
        <div className="grid gap-4 sm:grid-cols-2">
          {!role && <Field label="Code" htmlFor="rc" required hint="CAPITALS, e.g. MEDIUM_SUPERVISOR"><Input id="rc" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></Field>}
          <Field label="Name" htmlFor="rn" required><Input id="rn" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
        <div className="grid gap-4">
          {modules.map((m) => (
            <fieldset key={m} className="rounded-lg border p-3">
              <legend className="px-1 text-sm font-semibold">{m}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {PERMISSION_META.filter((p) => p.module === m).map((p) => (
                  <label key={p.code} className={cn('flex items-start gap-2 rounded-md p-1.5 text-sm hover:bg-muted/50')}>
                    <Checkbox className="mt-0.5" checked={perms.has(p.code)} onChange={() => toggle(p.code)} />
                    <span>{p.description}<span className="block font-mono text-[11px] text-muted-foreground">{p.code}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} disabled={!name.trim() || (!role && !/^[A-Z0-9_]{2,40}$/.test(code))} onClick={() => save.mutate(role ? { name, permissions: [...perms] } : { code, name, permissions: [...perms] })}>Save role</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ======================================================================= Audit logs
export function AuditLogsPage() {
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<AuditLog | null>(null);
  const facets = useQuery({ queryKey: ['audit', 'facets'], queryFn: () => api.get<{ entityTypes: string[]; actions: string[] }>('/audit-logs/facets') });
  const list = useQuery({
    queryKey: ['audit', { page, entityType, action, from, to }],
    queryFn: () => api.get<Page<AuditLog>>(`/audit-logs${qs({ page, pageSize: 25, entityType, action, from, to })}`),
    placeholderData: (p) => p,
  });
  const reset = () => setPage(1);
  return (
    <>
      <PageHeader title="Audit Logs" description="Every important change: who, what, when, before and after. Logs cannot be edited." />
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="Record type" htmlFor="aet"><Select id="aet" className="w-44" value={entityType} onChange={(e) => { setEntityType(e.target.value); reset(); }}><option value="">All</option>{facets.data?.entityTypes.map((x) => <option key={x}>{x}</option>)}</Select></Field>
        <Field label="Action" htmlFor="aac"><Select id="aac" className="w-44" value={action} onChange={(e) => { setAction(e.target.value); reset(); }}><option value="">All</option>{facets.data?.actions.map((x) => <option key={x}>{x}</option>)}</Select></Field>
        <Field label="From" htmlFor="afr"><Input id="afr" type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} /></Field>
        <Field label="To" htmlFor="ato"><Input id="ato" type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} /></Field>
      </Card>
      <Card>
        <QueryView query={list} empty={(d) => (d.data.length ? null : <EmptyState title="No matching log entries" />)}>
          {(d) => (
            <>
              <Table>
                <THead><TR><TH>When</TH><TH>User</TH><TH>Action</TH><TH>Record</TH><TH>Changes</TH></TR></THead>
                <TBody>
                  {d.data.map((l) => (
                    <TR key={l.id} className="cursor-pointer" onClick={() => setOpen(l)}>
                      <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(l.createdAt)}</TD>
                      <TD>{l.username ?? '—'}</TD>
                      <TD><Badge variant={l.action.includes('FAIL') || l.action.includes('LOCK') || l.action.includes('REUSE') ? 'destructive' : 'secondary'}>{l.action}</Badge></TD>
                      <TD>{l.entityType}{l.entityId ? ` #${l.entityId}` : ''}</TD>
                      <TD className="max-w-xs truncate text-xs text-muted-foreground">{l.afterData ? Object.keys(l.afterData).slice(0, 4).join(', ') : l.reason ?? ''}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <Pagination page={d.meta.page} pageSize={d.meta.pageSize} total={d.meta.total} onPage={setPage} />
            </>
          )}
        </QueryView>
      </Card>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(null)}>
          <DialogContent title={`${open.action} · ${open.entityType}${open.entityId ? ` #${open.entityId}` : ''}`} description={`${open.username ?? 'system'} · ${formatDateTime(open.createdAt)}${open.ip ? ` · ${open.ip}` : ''}`} wide>
            {open.reason && <p className="text-sm"><span className="font-medium">Reason:</span> {open.reason}</p>}
            <AuditDiff before={open.beforeData} after={open.afterData} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function AuditDiff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  if (!keys.length) return <p className="text-sm text-muted-foreground">No field changes recorded.</p>;
  const show = (v: unknown) => (v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <Table>
      <THead><TR><TH>Field</TH><TH>Before</TH><TH>After</TH></TR></THead>
      <TBody>
        {keys.map((k) => (
          <TR key={k}>
            <TD className="font-mono text-xs">{k}</TD>
            <TD className="max-w-60 break-words text-xs text-destructive">{show(before?.[k])}</TD>
            <TD className="max-w-60 break-words text-xs text-success">{show(after?.[k])}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

