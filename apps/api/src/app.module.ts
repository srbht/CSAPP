import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './common/audit';
import { AuthGuard, Public } from './common/auth';
import { ProblemDetailsFilter } from './common/errors';
import { ScopeModule } from './common/scope';
import { SerializeInterceptor } from './common/serialize';
import { config } from './config';
import { PrismaModule, PrismaService } from './infra/prisma.service';
import { StorageModule } from './infra/storage.service';
import { AcademicModule } from './modules/academic.module';
import { AuthModule } from './modules/auth.module';
import { ClassesModule } from './modules/classes.module';
import { PoliciesSequencesModule } from './modules/policies-sequences.module';
import { SchoolModule } from './modules/school.module';
import { StaffModule } from './modules/staff.module';
import { StudentsModule } from './modules/students.module';
import { ExamsModule } from './modules/exams.module';
import { GreensheetModule } from './modules/greensheet.module';
import { BlankSheetsModule } from './modules/blank-sheets.module';
import { MarksImportModule } from './modules/marks-import.module';
import { PerformanceModule } from './modules/performance.module';
import { MonthlyModule } from './modules/monthly.module';
import { ReportCardsModule } from './modules/reportcards.module';
import { WorkflowModule } from './modules/workflow.module';
import { StudentImportModule } from './modules/student-import.module';
import { FeesModule } from './modules/fees.module';
import { FeeInstalmentsModule } from './modules/fee-instalments.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ExpensesModule } from './modules/expenses.module';
import { DashboardModule } from './modules/dashboard.module';
import { SubjectsGradingModule } from './modules/subjects-grading.module';
import { UsersModule } from './modules/users.module';

@Controller()
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public() @Get('health')
  health() { return { status: 'ok' }; }

  @Public() @Get('ready')
  async ready() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ready' };
  }
}

const cfg = config();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: cfg.NODE_ENV === 'test' ? 'silent' : 'info',
        transport: cfg.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'req.body.password'],
        genReqId: (req) => (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
      },
    }),
    // In-memory throttling for a single API process; switches to Redis storage when the API is scaled out.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: cfg.API_RATE_LIMIT_PER_MINUTE }]),
    JwtModule.register({ global: true, secret: cfg.JWT_ACCESS_SECRET, signOptions: { algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } }),
    PrismaModule, AuditModule, ScopeModule, StorageModule,
    AuthModule, SchoolModule, AcademicModule, ClassesModule, SubjectsGradingModule, PoliciesSequencesModule, StaffModule, StudentsModule, StudentImportModule, ExamsModule, WorkflowModule, ReportCardsModule, GreensheetModule, BlankSheetsModule, MarksImportModule, PerformanceModule, MonthlyModule, FeesModule, FeeInstalmentsModule, ExpensesModule, ReportsModule, DashboardModule, UsersModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_INTERCEPTOR, useClass: SerializeInterceptor },
  ],
})
export class AppModule {}
