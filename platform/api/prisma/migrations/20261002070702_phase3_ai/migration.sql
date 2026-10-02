-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "i18n" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "i18n" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "input" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "versionId" TEXT,
    "topicId" TEXT,
    "requestedById" TEXT NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCall" (
    "id" TEXT NOT NULL,
    "useCase" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptKey" TEXT,
    "promptVersion" INTEGER,
    "jobId" TEXT,
    "actorId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "piiRedactions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "system" TEXT NOT NULL,
    "user" TEXT NOT NULL,
    "schemaName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "hash" TEXT NOT NULL,
    "createdById" TEXT,
    "approvedById" TEXT,
    "evalScore" DOUBLE PRECISION,
    "evalReport" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityFinding" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "topicId" TEXT,
    "jobId" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "current" BOOLEAN NOT NULL DEFAULT true,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualityFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptManifest" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "rev" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformConfig" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "GenerationJob_status_createdAt_idx" ON "GenerationJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_versionId_idx" ON "GenerationJob"("versionId");

-- CreateIndex
CREATE INDEX "AiCall_actorId_createdAt_idx" ON "AiCall"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCall_createdAt_idx" ON "AiCall"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_key_version_key" ON "PromptTemplate"("key", "version");

-- CreateIndex
CREATE INDEX "QualityFinding_versionId_current_idx" ON "QualityFinding"("versionId", "current");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptManifest_topicId_rev_key" ON "ScriptManifest"("topicId", "rev");

CREATE TRIGGER script_manifest_immutable BEFORE UPDATE OR DELETE ON "ScriptManifest"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
