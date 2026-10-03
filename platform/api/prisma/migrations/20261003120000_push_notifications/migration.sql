-- expand-contract: the UPDATE only backfills the brand-new pushedAt column so old notifications are not pushed retroactively
-- Push notifications (expand only: a new nullable column, a new table, new indexes).
ALTER TABLE "Notification" ADD COLUMN "pushedAt" TIMESTAMP(3);
-- Notifications that already exist were shown in the app; do not push them retroactively.
UPDATE "Notification" SET "pushedAt" = "createdAt";

CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "keys" JSONB,
    "language" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushDevice_token_key" ON "PushDevice"("token");
CREATE INDEX "PushDevice_userId_idx" ON "PushDevice"("userId");
CREATE INDEX "Notification_pushedAt_createdAt_idx" ON "Notification"("pushedAt", "createdAt");
