-- CreateEnum
CREATE TYPE "QType" AS ENUM ('MCQ_SINGLE', 'MCQ_MULTI', 'NUMERIC');

-- CreateEnum
CREATE TYPE "OverrideType" AS ENUM ('UNLOCK_TOPIC', 'EXTRA_QUIZ_ATTEMPTS');

-- AlterTable
ALTER TABLE "Topic" ADD COLUMN     "mandatory" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ContentAsset" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'VIDEO',
    "language" TEXT NOT NULL DEFAULT 'en',
    "durationSec" DOUBLE PRECISION,
    "files" JSONB NOT NULL DEFAULT '{}',
    "interactions" JSONB NOT NULL DEFAULT '[]',
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "rights" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quiz" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "passPercent" INTEGER NOT NULL DEFAULT 70,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "Quiz_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "QType" NOT NULL,
    "text" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "answer" JSONB NOT NULL,
    "tolerance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 1,
    "rationale" TEXT,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "rubric" JSONB NOT NULL DEFAULT '{}',
    "maxSubmissions" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizAttempt" (
    "id" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "answers" JSONB,
    "scorePercent" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "QuizAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "topicId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "deviceId" TEXT,
    "seq" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicProgress" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "videoRanges" JSONB NOT NULL DEFAULT '{}',
    "responses" JSONB NOT NULL DEFAULT '{}',
    "resumeAssetId" TEXT,
    "resumeSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "resumeAt" TIMESTAMP(3),
    "videoDone" BOOLEAN NOT NULL DEFAULT false,
    "quizPassed" BOOLEAN NOT NULL DEFAULT false,
    "assignmentSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgressionOverride" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "type" "OverrideType" NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgressionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "publicKeyPem" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflinePackage" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflinePackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineLicense" (
    "id" TEXT NOT NULL,
    "deviceRowId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "OfflineLicense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentAsset_topicId_idx" ON "ContentAsset"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "Quiz_topicId_key" ON "Quiz"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "Question_quizId_position_key" ON "Question"("quizId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_topicId_key" ON "Assignment"("topicId");

-- CreateIndex
CREATE INDEX "QuizAttempt_entitlementId_topicId_idx" ON "QuizAttempt"("entitlementId", "topicId");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_assignmentId_learnerId_attemptNo_key" ON "Submission"("assignmentId", "learnerId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "LearningEvent_eventId_key" ON "LearningEvent"("eventId");

-- CreateIndex
CREATE INDEX "LearningEvent_entitlementId_topicId_idx" ON "LearningEvent"("entitlementId", "topicId");

-- CreateIndex
CREATE UNIQUE INDEX "TopicProgress_entitlementId_topicId_key" ON "TopicProgress"("entitlementId", "topicId");

-- CreateIndex
CREATE INDEX "ProgressionOverride_entitlementId_topicId_idx" ON "ProgressionOverride"("entitlementId", "topicId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Device_userId_deviceId_key" ON "Device"("userId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "OfflinePackage_assetId_label_key" ON "OfflinePackage"("assetId", "label");

-- CreateIndex
CREATE INDEX "OfflineLicense_entitlementId_idx" ON "OfflineLicense"("entitlementId");

-- CreateIndex
CREATE INDEX "OfflineLicense_deviceRowId_idx" ON "OfflineLicense"("deviceRowId");

-- AddForeignKey
ALTER TABLE "ContentAsset" ADD CONSTRAINT "ContentAsset_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quiz" ADD CONSTRAINT "Quiz_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Learning ledger and submissions are append-only (build prompt: critical academic records not destructively edited).
CREATE TRIGGER learning_event_immutable BEFORE UPDATE OR DELETE ON "LearningEvent"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER submission_immutable BEFORE UPDATE OR DELETE ON "Submission"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
