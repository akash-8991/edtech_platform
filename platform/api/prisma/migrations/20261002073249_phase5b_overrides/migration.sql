-- CreateTable
CREATE TABLE "GradeOverride" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "dimensions" JSONB NOT NULL,
    "feedback" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "GradeOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GradeOverride_submissionId_status_idx" ON "GradeOverride"("submissionId", "status");
