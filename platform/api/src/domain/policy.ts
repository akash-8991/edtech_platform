// Configurable academic policy (ADM-001). Defaults are ASSUMPTIONS pending [ACADEMIC_POLICIES]; see docs/decision-log.md D-005.
export interface Policy {
  maxPauses: number;          // IAM-004: configured count
  maxPausedDays: number;      // IAM-004: cumulative days
  pauseNoticeDays: number;    // IAM-004: notice before pause starts (0 = immediate)
  durationMonths: Record<'M12' | 'M18', number>;
  segregationOfDuties: boolean; // REV-002
}

export const defaultPolicy = (): Policy => ({
  maxPauses: Number(process.env.POLICY_MAX_PAUSES ?? 2),
  maxPausedDays: Number(process.env.POLICY_MAX_PAUSED_DAYS ?? 60),
  pauseNoticeDays: Number(process.env.POLICY_PAUSE_NOTICE_DAYS ?? 0),
  durationMonths: { M12: 12, M18: 18 },
  segregationOfDuties: (process.env.SEGREGATION_OF_DUTIES ?? 'true') !== 'false',
});
