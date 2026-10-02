-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'LAB_COORDINATOR';

-- CreateTable
CREATE TABLE "LabActivity" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "topicId" TEXT,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "manual" TEXT NOT NULL DEFAULT '',
    "safetyText" TEXT NOT NULL,
    "safetyHash" TEXT NOT NULL,
    "prerequisiteTopicIds" TEXT[],
    "outcomes" JSONB NOT NULL DEFAULT '[]',
    "requireEvidence" BOOLEAN NOT NULL DEFAULT true,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabSlot" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabAck" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabAck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabBooking" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BOOKED',
    "attendedAt" TIMESTAMP(3),
    "attendanceMethod" TEXT,
    "markedById" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "evidenceAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "LabBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamDefinition" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "durationMin" INTEGER NOT NULL,
    "passPercent" INTEGER NOT NULL DEFAULT 50,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "cooldownDays" INTEGER NOT NULL DEFAULT 7,
    "eligibility" JSONB NOT NULL,
    "blueprint" JSONB NOT NULL,
    "proctoring" JSONB NOT NULL,
    "shuffle" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamQuestion" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "difficulty" INTEGER NOT NULL DEFAULT 2,
    "type" "QType" NOT NULL,
    "text" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "answer" JSONB NOT NULL,
    "tolerance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 1,
    "i18n" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamSession" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "mode" TEXT NOT NULL,
    "centre" TEXT,
    "capacity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamRegistration" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAccommodation" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "examId" TEXT,
    "type" TEXT NOT NULL,
    "extraTimePercent" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamAccommodation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EligibilityOverride" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EligibilityOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAttempt" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CHECKED_IN',
    "consentAt" TIMESTAMP(3),
    "consentHash" TEXT,
    "deviceCheck" JSONB,
    "idCheck" JSONB,
    "providerSessionId" TEXT,
    "launchUrl" TEXT,
    "proctorReportFinal" BOOLEAN NOT NULL DEFAULT false,
    "sessionTokenHash" TEXT,
    "sessionSwitches" INTEGER NOT NULL DEFAULT 0,
    "paper" JSONB,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "saveSeq" INTEGER NOT NULL DEFAULT 0,
    "lastSavedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "extraTimePercent" INTEGER NOT NULL DEFAULT 0,
    "watermark" TEXT,
    "score" JSONB,
    "passed" BOOLEAN,
    "resultState" TEXT NOT NULL DEFAULT 'NONE',
    "outcome" TEXT,
    "outcomeReason" TEXT,
    "outcomeById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamEvent" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamSubmission" (
    "attemptId" TEXT NOT NULL,
    "receiptCode" TEXT NOT NULL,
    "answersHash" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamSubmission_pkey" PRIMARY KEY ("attemptId")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "providerEventId" TEXT,
    "evidenceUrl" TEXT,
    "evidenceExpiresAt" TIMESTAMP(3),
    "detail" JSONB NOT NULL DEFAULT '{}',
    "decidedById" TEXT,
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProctorWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProctorWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAppeal" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "excludedAdjudicators" TEXT[],
    "decidedById" TEXT,
    "decision" TEXT,
    "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ExamAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LabActivity_versionId_code_key" ON "LabActivity"("versionId", "code");

-- CreateIndex
CREATE INDEX "LabSlot_activityId_startsAt_idx" ON "LabSlot"("activityId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "LabAck_activityId_learnerId_textHash_key" ON "LabAck"("activityId", "learnerId", "textHash");

-- CreateIndex
CREATE INDEX "LabBooking_activityId_learnerId_idx" ON "LabBooking"("activityId", "learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "LabBooking_slotId_learnerId_key" ON "LabBooking"("slotId", "learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamDefinition_versionId_code_key" ON "ExamDefinition"("versionId", "code");

-- CreateIndex
CREATE INDEX "ExamQuestion_programmeId_tag_status_idx" ON "ExamQuestion"("programmeId", "tag", "status");

-- CreateIndex
CREATE INDEX "ExamSession_examId_startsAt_idx" ON "ExamSession"("examId", "startsAt");

-- CreateIndex
CREATE INDEX "ExamRegistration_examId_learnerId_idx" ON "ExamRegistration"("examId", "learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamRegistration_sessionId_learnerId_key" ON "ExamRegistration"("sessionId", "learnerId");

-- CreateIndex
CREATE INDEX "ExamAccommodation_learnerId_active_idx" ON "ExamAccommodation"("learnerId", "active");

-- CreateIndex
CREATE INDEX "EligibilityOverride_examId_learnerId_idx" ON "EligibilityOverride"("examId", "learnerId");

-- CreateIndex
CREATE INDEX "ExamAttempt_sessionId_status_idx" ON "ExamAttempt"("sessionId", "status");

-- CreateIndex
CREATE INDEX "ExamAttempt_resultState_idx" ON "ExamAttempt"("resultState");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttempt_examId_learnerId_attemptNo_key" ON "ExamAttempt"("examId", "learnerId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "ExamEvent_attemptId_seq_key" ON "ExamEvent"("attemptId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_providerEventId_key" ON "Incident"("providerEventId");

-- CreateIndex
CREATE INDEX "Incident_attemptId_idx" ON "Incident"("attemptId");

-- CreateIndex
CREATE INDEX "Incident_status_severity_idx" ON "Incident"("status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "ProctorWebhookEvent_eventId_key" ON "ProctorWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "ExamAppeal_attemptId_idx" ON "ExamAppeal"("attemptId");

-- Exam evidence is tamper-evident and append-only: event chain, submission receipt, proctor webhook log.
CREATE TRIGGER exam_event_immutable BEFORE UPDATE OR DELETE ON "ExamEvent" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER exam_submission_immutable BEFORE UPDATE OR DELETE ON "ExamSubmission" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER proctor_webhook_immutable BEFORE UPDATE OR DELETE ON "ProctorWebhookEvent" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
