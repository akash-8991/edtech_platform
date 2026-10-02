-- CreateTable
CREATE TABLE "TutorChunk" (
    "id" TEXT NOT NULL,
    "versionId" TEXT,
    "programmeId" TEXT NOT NULL,
    "topicId" TEXT,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "faqId" TEXT,
    "embedding" DOUBLE PRECISION[],
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TutorChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorConversation" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "topicId" TEXT,
    "unsupportedStreak" INTEGER NOT NULL DEFAULT 0,
    "ticketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TutorConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT,
    "confidence" TEXT,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "retrieved" JSONB NOT NULL DEFAULT '[]',
    "groundedness" DOUBLE PRECISION,
    "safetyFlags" JSONB NOT NULL DEFAULT '[]',
    "provider" TEXT,
    "model" TEXT,
    "promptVersion" INTEGER,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "helpful" BOOLEAN,
    "feedback" TEXT,
    "topicId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TutorMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaqEntry" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "topicId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'FAQ',
    "language" TEXT NOT NULL DEFAULT 'en',
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sourceTicketId" TEXT,
    "proposedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaqEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherProfile" (
    "userId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "disciplines" TEXT[],
    "skills" TEXT[],
    "languages" TEXT[],
    "capacity" INTEGER NOT NULL DEFAULT 10,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "lastAssignedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "DoubtTicket" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "learnerId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "topicId" TEXT,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "assignedTeacherId" TEXT,
    "routingNote" TEXT,
    "contextBundle" JSONB NOT NULL DEFAULT '{}',
    "conversationId" TEXT,
    "firstResponseDueAt" TIMESTAMP(3) NOT NULL,
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolutionSummary" TEXT,
    "slaBreachedAt" TIMESTAMP(3),
    "rerouteCount" INTEGER NOT NULL DEFAULT 0,
    "rating" INTEGER,
    "ratingComment" TEXT,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoubtTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorRole" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "meetingRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TutorChunk_versionId_idx" ON "TutorChunk"("versionId");

-- CreateIndex
CREATE INDEX "TutorChunk_programmeId_kind_idx" ON "TutorChunk"("programmeId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "TutorChunk_ref_language_versionId_key" ON "TutorChunk"("ref", "language", "versionId");

-- CreateIndex
CREATE INDEX "TutorConversation_learnerId_updatedAt_idx" ON "TutorConversation"("learnerId", "updatedAt");

-- CreateIndex
CREATE INDEX "TutorMessage_conversationId_createdAt_idx" ON "TutorMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "TutorMessage_status_createdAt_idx" ON "TutorMessage"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FaqEntry_programmeId_status_idx" ON "FaqEntry"("programmeId", "status");

-- CreateIndex
CREATE INDEX "DoubtTicket_status_assignedTeacherId_idx" ON "DoubtTicket"("status", "assignedTeacherId");

-- CreateIndex
CREATE INDEX "DoubtTicket_learnerId_createdAt_idx" ON "DoubtTicket"("learnerId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_createdAt_idx" ON "TicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "Appointment_teacherId_startsAt_idx" ON "Appointment"("teacherId", "startsAt");

-- Conversation evidence and ticket thread are append-only: learners/teachers cannot rewrite what was said.
CREATE OR REPLACE FUNCTION forbid_update_keep_feedback() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on % is forbidden: table is append-only', TG_TABLE_NAME; END IF;
  -- only learner feedback columns may change on a tutor message
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.citations IS DISTINCT FROM OLD.citations OR NEW.retrieved IS DISTINCT FROM OLD.retrieved
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'UPDATE of evidence columns on % is forbidden', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tutor_message_evidence BEFORE UPDATE OR DELETE ON "TutorMessage"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_keep_feedback();
CREATE TRIGGER ticket_message_immutable BEFORE UPDATE OR DELETE ON "TicketMessage"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
