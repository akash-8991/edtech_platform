-- AlterEnum
ALTER TYPE "OverrideType" ADD VALUE 'DEADLINE_EXTENSION';

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "policy" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "runAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "contentHash" TEXT;

-- CreateTable
CREATE TABLE "SubmissionArtifact" (
    "submissionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "testResults" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionArtifact_pkey" PRIMARY KEY ("submissionId")
);

-- CreateTable
CREATE TABLE "GradeRecord" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "dimensions" JSONB NOT NULL,
    "rawPercent" DOUBLE PRECISION NOT NULL,
    "latePenaltyPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "finalPercent" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "confidence" DOUBLE PRECISION,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "feedback" TEXT NOT NULL DEFAULT '',
    "provider" TEXT,
    "model" TEXT,
    "promptKey" TEXT,
    "promptVersion" INTEGER,
    "promptHash" TEXT,
    "samples" INTEGER NOT NULL DEFAULT 1,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionGrade" (
    "submissionId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING_AI',
    "currentSeq" INTEGER,
    "finalPercent" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "aiPercent" DOUBLE PRECISION,
    "humanPercent" DOUBLE PRECISION,
    "moderationReasons" JSONB NOT NULL DEFAULT '[]',
    "aiAttempts" INTEGER NOT NULL DEFAULT 0,
    "releasedAt" TIMESTAMP(3),
    "appealDeadline" TIMESTAMP(3),
    "appealCount" INTEGER NOT NULL DEFAULT 0,
    "integrityOutcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubmissionGrade_pkey" PRIMARY KEY ("submissionId")
);

-- CreateTable
CREATE TABLE "ModerationTask" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "claimedById" TEXT,
    "excludedModeratorId" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ModerationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimilarityMatch" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "otherSubmissionId" TEXT,
    "kind" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimilarityMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GradeRecord_submissionId_seq_key" ON "GradeRecord"("submissionId", "seq");

-- CreateIndex
CREATE INDEX "SubmissionGrade_state_updatedAt_idx" ON "SubmissionGrade"("state", "updatedAt");

-- CreateIndex
CREATE INDEX "SubmissionGrade_versionId_assignmentId_idx" ON "SubmissionGrade"("versionId", "assignmentId");

-- CreateIndex
CREATE INDEX "SubmissionGrade_learnerId_topicId_idx" ON "SubmissionGrade"("learnerId", "topicId");

-- CreateIndex
CREATE INDEX "ModerationTask_status_kind_createdAt_idx" ON "ModerationTask"("status", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationTask_submissionId_idx" ON "ModerationTask"("submissionId");

-- CreateIndex
CREATE INDEX "SimilarityMatch_submissionId_idx" ON "SimilarityMatch"("submissionId");

-- Grade history is append-only (ASN-005): corrections are new records, never edits.
CREATE TRIGGER grade_record_immutable BEFORE UPDATE OR DELETE ON "GradeRecord"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
