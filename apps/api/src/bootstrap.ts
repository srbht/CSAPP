import { INestApplication, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { config } from './config';

/** Shared by main.ts and the e2e tests so tests exercise the real HTTP pipeline. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const trust = config().TRUST_PROXY;
  app.set('trust proxy', trust === 'true' ? true : trust === 'false' ? false : /^\d+$/.test(trust) ? Number(trust) : trust);
  // Photos and PDFs are shown from blob: URLs made in the browser.
  app.use(helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'blob:'], 'frame-src': ["'self'", 'blob:'], 'object-src': ["'self'", 'blob:'] } } }));
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }] });
  const origin = config().CORS_ORIGIN;
  if (origin) app.enableCors({ origin: origin.split(','), credentials: true });
  serveWebsite(app);
  app.enableShutdownHooks();
  return app;
}

/** Serves the built website (WEB_DIST) next to the API; any other non-API path gets index.html (the app's own routes). */
function serveWebsite(app: NestExpressApplication) {
  const dir = config().WEB_DIST;
  if (!dir) return;
  const root = path.resolve(dir);
  if (!existsSync(path.join(root, 'index.html'))) throw new Error(`WEB_DIST: no index.html in ${root} (build the website first)`);
  // Hashed files never change; index.html must always be fresh so a new version shows up at once.
  app.use(express.static(root, { index: false, setHeaders: (res, file) => res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache') }));
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/') || req.path === '/health' || req.path === '/ready') return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(root, 'index.html'));
  });
}
