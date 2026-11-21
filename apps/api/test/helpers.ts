import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '../src/generated/prisma/client';
import { adapterFromUrl } from '../src/infra/db-adapter';
import { seedBase } from '../prisma/seed-data';

export const ADMIN = { username: 'admin', initial: 'Initial-pass1', password: 'Admin-pass-2026' };

export async function bootstrap() {
  // Import after global setup has populated env (config is read at import time).
  const { createApp } = await import('../src/bootstrap');
  const prisma = new PrismaClient({ adapter: adapterFromUrl(process.env.DATABASE_URL!) });
  await seedBase(prisma, { schoolCode: 'CPS', adminUsername: ADMIN.username, adminPassword: ADMIN.initial });
  const app = await createApp();
  await app.init();
  return { app, prisma };
}

export const api = (app: INestApplication) => request(app.getHttpServer());

export async function login(app: INestApplication, login: string, password: string) {
  const res = await api(app).post('/api/v1/auth/login').send({ login, password });
  if (res.status !== 200) throw new Error(`login failed for ${login}: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken as string, cookie: res.headers['set-cookie'] as unknown as string[], body: res.body };
}

/** Authenticated request helper bound to a token. */
export function as(app: INestApplication, token: string) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  return {
    get: (u: string) => auth(api(app).get(`/api/v1${u}`)),
    post: (u: string, b?: object) => auth(api(app).post(`/api/v1${u}`)).send(b ?? {}),
    patch: (u: string, b?: object) => auth(api(app).patch(`/api/v1${u}`)).send(b ?? {}),
    put: (u: string, b?: object) => auth(api(app).put(`/api/v1${u}`)).send(b ?? {}),
    delete: (u: string) => auth(api(app).delete(`/api/v1${u}`)),
    upload: (u: string, field: string, buf: Buffer, name: string) => auth(api(app).post(`/api/v1${u}`)).attach(field, buf, name),
  };
}
