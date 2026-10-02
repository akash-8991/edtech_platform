-- AlterTable
ALTER TABLE "User" ADD COLUMN     "erasedAt" TIMESTAMP(3),
ADD COLUMN     "failedLogins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "legalHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "mfaBackupHashes" TEXT[],
ADD COLUMN     "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfaLastStep" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfaSecretEnc" TEXT;

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authMethod" TEXT NOT NULL,
    "mfa" BOOLEAN NOT NULL DEFAULT false,
    "deviceLabel" TEXT NOT NULL DEFAULT '',
    "ip" TEXT,
    "uaHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcLogin" (
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OidcLogin_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "version" TEXT NOT NULL,
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSubjectRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "details" JSONB NOT NULL DEFAULT '{}',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decisionReason" TEXT,
    "exportKey" TEXT,
    "exportCrypto" JSONB,
    "exportExpiresAt" TIMESTAMP(3),
    "result" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DataSubjectRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "userId" TEXT NOT NULL,
    "prefs" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_purpose_at_idx" ON "ConsentRecord"("userId", "purpose", "at");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_userId_type_idx" ON "DataSubjectRequest"("userId", "type");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_status_idx" ON "DataSubjectRequest"("status");

-- Erasure support. Evidence tables stay append-only for everyone EXCEPT the privacy erasure routine, which sets
-- `SET LOCAL app.erasure = 'on'` inside its own transaction to redact personal text (never to delete academic records).
CREATE OR REPLACE FUNCTION forbid_update_keep_feedback() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.erasure', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on % is forbidden: table is append-only', TG_TABLE_NAME; END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.citations IS DISTINCT FROM OLD.citations OR NEW.retrieved IS DISTINCT FROM OLD.retrieved
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'UPDATE of evidence columns on % is forbidden', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_mutation_unless_erasure() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.erasure', true) = 'on' AND TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  RAISE EXCEPTION '% on % is forbidden: table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- ticket messages hold free text written by (or about) the learner: redactable under erasure, otherwise immutable
DROP TRIGGER IF EXISTS ticket_message_immutable ON "TicketMessage";
CREATE TRIGGER ticket_message_immutable BEFORE UPDATE OR DELETE ON "TicketMessage" FOR EACH ROW EXECUTE FUNCTION forbid_mutation_unless_erasure();
