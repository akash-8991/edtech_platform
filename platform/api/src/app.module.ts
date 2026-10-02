import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { IdempotencyInterceptor } from './common/idempotency';
import { BodyGuardPipe, dtoPipe } from './common/validation';
import { jwtSecrets } from './security/keyring';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService, ReadDb } from './common/prisma.service';
import { ActorRateLimitGuard, AuthGuard } from './common/auth';
import { HealthController } from './platform/health';
import { CorsMiddleware, IpRateLimitMiddleware, RequestContextMiddleware } from './platform/middleware';
import { AuditController, AuditService } from './audit';
import { AuthController } from './security/auth.controller';
import { PrivacyService, PrivacyController } from './privacy/privacy';
import { IntegrityService, OpsController } from './ops/integrity';
import { AuthService } from './security/auth.service';
import { SessionService } from './security/sessions';
import { OidcService } from './security/oidc';
import { ApplicationsController, ApplicationsService } from './applications';
import { EntitlementsController, EntitlementsService } from './entitlements';
import { AuthoringController, AuthoringService } from './authoring';
import { CatalogueController } from './catalogue';
import { NotificationsController, NotificationsService } from './notifications';
import { buildScanner, buildStore, OBJECT_STORE, SCANNER, StorageService } from './storage';
import { LearningController, ProgressionService } from './learning';
import { ContentController } from './content';
import { MediaController } from './media';
import { ReportsController } from './reports';
import { AI_PROVIDERS, buildProviders } from './ai/providers';
import { GatewayService } from './ai/gateway';
import { ConfigService } from './ai/config';
import { PromptRegistry } from './ai/prompts';
import { GenerationService, JobWorker } from './ai/generation';
import { AiController } from './ai/ai.controller';
import { SANDBOX, buildSandbox } from './grading/sandbox';
import { GradingService } from './grading/grading';
import { GradingController } from './grading/grading.controller';
import { PROCTOR, buildProctor } from './proctoring/provider';
import { LabsService, LabsController } from './labs/labs';
import { ExamsService, ExamsController } from './exams/exams';
import { ExamOpsService, ExamOpsController } from './exams/ops';
import { EMBEDDER, buildEmbedder } from './ai/embeddings';
import { TutorIndexService } from './tutor/tutor-index';
import { TutorService, TutorController, AnalyticsController } from './tutor/tutor';
import { DoubtService, DoubtsController } from './doubts/doubts';

@Module({
  imports: [JwtModule.registerAsync({ global: true, useFactory: () => ({ secret: jwtSecrets().current }) })], // read at DI time, after the secret store has been loaded
  controllers: [HealthController, AuthController, AuditController, ApplicationsController, EntitlementsController, AuthoringController, CatalogueController, NotificationsController, LearningController, ContentController, MediaController, ReportsController, AiController, TutorController, AnalyticsController, DoubtsController, GradingController, LabsController, ExamsController, ExamOpsController, PrivacyController, OpsController],
  providers: [PrismaService, ReadDb, AuditService, ApplicationsService, EntitlementsService, AuthoringService, NotificationsService, { provide: OBJECT_STORE, useFactory: () => buildStore() }, { provide: SCANNER, useFactory: () => buildScanner() }, StorageService, ProgressionService, { provide: AI_PROVIDERS, useFactory: () => buildProviders() }, GatewayService, ConfigService, PromptRegistry, GenerationService, JobWorker, { provide: EMBEDDER, useFactory: () => buildEmbedder() }, TutorIndexService, TutorService, DoubtService, { provide: SANDBOX, useFactory: () => buildSandbox() }, GradingService, { provide: PROCTOR, useFactory: () => buildProctor() }, LabsService, ExamsService, ExamOpsService, AuthService, SessionService, PrivacyService, IntegrityService, { provide: 'SESSION_SERVICE', useExisting: SessionService }, OidcService, { provide: APP_PIPE, useClass: BodyGuardPipe }, { provide: APP_PIPE, useFactory: dtoPipe }, { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_GUARD, useClass: ActorRateLimitGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply(RequestContextMiddleware, CorsMiddleware, IpRateLimitMiddleware).forRoutes('*'); }
}
