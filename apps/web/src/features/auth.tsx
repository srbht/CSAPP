import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordSchema, loginSchema, type ChangePasswordInput, type LoginInput } from '@cps/shared';
import { GraduationCap } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { applyServerErrors, errorMessage } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';
import { Card, CardContent } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export function LoginPage() {
  const { t } = useTranslation();
  const { login, status, me } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { login: '', password: '' } });

  if (status === 'signedIn') return <Navigate to={me?.mustChangePassword ? '/change-password' : '/'} replace />;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await login(v.login, v.password);
      navigate(r.mustChangePassword ? '/change-password' : '/', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot sign in right now.');
    }
  });

  return (
    <div className="grid min-h-dvh place-items-center bg-gradient-to-br from-indigo-50 via-background to-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground shadow-md"><GraduationCap className="size-6" /></div>
          <h1 className="text-xl font-semibold">Children Public School</h1>
          <p className="text-sm text-muted-foreground">School ERP</p>
        </div>
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold">{t('login.title')}</h2>
            <p className="mb-5 text-sm text-muted-foreground">{t('login.subtitle')}</p>
            <form onSubmit={onSubmit} className="grid gap-4" noValidate>
              <Field label={t('login.username')} htmlFor="login" error={form.formState.errors.login?.message}>
                <Input id="login" autoComplete="username" autoFocus {...form.register('login')} aria-invalid={!!form.formState.errors.login} />
              </Field>
              <Field label={t('login.password')} htmlFor="password" error={form.formState.errors.password?.message}>
                <Input id="password" type="password" autoComplete="current-password" {...form.register('password')} aria-invalid={!!form.formState.errors.password} />
              </Field>
              {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p>}
              <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>{t('login.submit')}</Button>
            </form>
            <p className="mt-4 text-center text-xs text-muted-foreground">{t('login.forgot')}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function ChangePasswordPage() {
  const { t } = useTranslation();
  const { me, reloadMe, logout } = useAuth();
  const navigate = useNavigate();
  const form = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema), defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' } });
  const forced = me?.mustChangePassword;

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await api.post('/auth/change-password', v);
      toast.success('Password changed. Other devices have been signed out.');
      await reloadMe();
      navigate('/', { replace: true });
    } catch (e) {
      if (!applyServerErrors(e, form.setError, ['currentPassword', 'newPassword', 'confirmPassword'])) toast.error(errorMessage(e));
    }
  });

  const body = (
    <Card className="w-full max-w-md">
      <CardContent>
        <h1 className="text-lg font-semibold">{t('common.changePassword')}</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          {forced ? 'For security, please set your own password before continuing.' : 'Use at least 8 characters with letters and numbers.'}
        </p>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <Field label="Current password" htmlFor="cur" required error={form.formState.errors.currentPassword?.message}>
            <Input id="cur" type="password" autoComplete="current-password" {...form.register('currentPassword')} />
          </Field>
          <Field label="New password" htmlFor="new" required error={form.formState.errors.newPassword?.message} hint="At least 8 characters, letters and numbers">
            <Input id="new" type="password" autoComplete="new-password" {...form.register('newPassword')} />
          </Field>
          <Field label="Confirm new password" htmlFor="conf" required error={form.formState.errors.confirmPassword?.message}>
            <Input id="conf" type="password" autoComplete="new-password" {...form.register('confirmPassword')} />
          </Field>
          <div className="flex justify-between gap-2">
            {forced ? <Button type="button" variant="ghost" onClick={() => void logout()}>{t('common.signOut')}</Button> : <Button type="button" variant="outline" onClick={() => navigate(-1)}>{t('common.cancel')}</Button>}
            <Button type="submit" loading={form.formState.isSubmitting}>{t('common.save')}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
  return forced ? <div className="grid min-h-dvh place-items-center px-4">{body}</div> : <div className="flex justify-center pt-6">{body}</div>;
}
