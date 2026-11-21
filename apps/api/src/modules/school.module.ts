/// <reference types="multer" />
import {
  Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, Patch, Post, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ERROR_CODES, PERMISSIONS, SchoolProfileInput, schoolProfileSchema } from '@cps/shared';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { AuditService } from '../common/audit';
import { AccessContext, Ctx, RequirePermission } from '../common/auth';
import { AppError, notFound } from '../common/errors';
import { StreamMarker } from '../common/serialize';
import { IdPipe, zBody } from '../common/validation';
import { PrismaService } from '../infra/prisma.service';
import { sniffImage, StorageDriver } from '../infra/storage.service';

const BRANDING = { logo: 'logoFileId', stamp: 'stampFileId', 'principal-signature': 'principalSignFileId' } as const;
type BrandingKind = keyof typeof BRANDING;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

@Injectable()
export class SchoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject('STORAGE') private readonly storage: StorageDriver,
  ) {}

  get(ctx: AccessContext) {
    return this.prisma.school.findUniqueOrThrow({ where: { id: ctx.schoolId } });
  }

  async update(ctx: AccessContext, input: SchoolProfileInput) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.school.findUniqueOrThrow({ where: { id: ctx.schoolId } });
      const after = await tx.school.update({
        where: { id: ctx.schoolId },
        data: { ...input, updatedBy: ctx.userId, version: { increment: 1 } },
      });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'School', entityId: after.id, before, after }, tx);
      return after;
    });
  }

  async uploadBranding(ctx: AccessContext, kind: BrandingKind, file: Express.Multer.File | undefined) {
    if (!BRANDING[kind]) throw notFound('Upload type');
    if (!file) throw new AppError(422, ERROR_CODES.VALIDATION_FAILED, 'Choose an image file to upload');
    if (file.size > MAX_IMAGE_BYTES) throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'Image must be 2 MB or smaller');
    const type = sniffImage(file.buffer);
    if (!type) throw new AppError(415, ERROR_CODES.VALIDATION_FAILED, 'Only PNG, JPEG or WebP images are allowed');

    const key = await this.storage.put(`schools/${ctx.schoolId}/branding`, type.ext, file.buffer);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.file.create({
        data: {
          schoolId: ctx.schoolId, storageDriver: this.storage.name, storageKey: key,
          originalName: file.originalname.slice(0, 255), mimeType: type.mime, sizeBytes: BigInt(file.size),
          sha256: createHash('sha256').update(file.buffer).digest('hex'), purpose: `BRANDING_${kind.toUpperCase()}`,
          createdBy: ctx.userId,
        },
      });
      const field = BRANDING[kind];
      const before = await tx.school.findUniqueOrThrow({ where: { id: ctx.schoolId } });
      const after = await tx.school.update({ where: { id: ctx.schoolId }, data: { [field]: row.id, updatedBy: ctx.userId } });
      await this.audit.record(ctx, { action: 'UPDATE', entityType: 'School', entityId: after.id, before, after, reason: `Uploaded ${kind}` }, tx);
      return after;
    });
  }

  /** Branding images are readable by any signed-in user of the school. Other file purposes arrive in later phases. */
  async streamFile(ctx: AccessContext, id: bigint, res: Response) {
    const f = await this.prisma.file.findFirst({ where: { id, schoolId: ctx.schoolId } });
    if (!f || !f.purpose.startsWith('BRANDING_')) throw notFound('File');
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    this.storage.read(f.storageKey).pipe(res);
    return new StreamMarker();
  }
}

@Controller()
export class SchoolController {
  constructor(private readonly school: SchoolService) {}

  @Get('school')
  get(@Ctx() ctx: AccessContext) {
    return this.school.get(ctx);
  }

  @Patch('school')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  update(@Ctx() ctx: AccessContext, @Body(zBody(schoolProfileSchema)) body: SchoolProfileInput) {
    return this.school.update(ctx, body);
  }

  @Post('school/:kind')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES + 1, files: 1 } }))
  upload(@Ctx() ctx: AccessContext, @Param('kind') kind: string, @UploadedFile() file?: Express.Multer.File) {
    return this.school.uploadBranding(ctx, kind as BrandingKind, file);
  }

  @Get('files/:id/content')
  file(@Ctx() ctx: AccessContext, @Param('id', IdPipe) id: bigint, @Res() res: Response) {
    return this.school.streamFile(ctx, id, res);
  }
}

@Module({ controllers: [SchoolController], providers: [SchoolService] })
export class SchoolModule {}
