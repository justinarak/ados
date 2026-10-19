import type {
  BudgetMutationRequest,
  CanonicalConversionEvent,
  ConsentEnvelope,
  PlatformDestination,
} from "@ados/schemas";

export interface CanonicalHashedUserData {
  em?: string; // SHA-256 lowercase trimmed email
  ph?: string; // SHA-256 E.164 phone
  fn?: string;
  ln?: string;
  ct?: string;
  st?: string;
  zp?: string;
  country?: string;
  external_id?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

export interface AdapterDispatchInput {
  event: CanonicalConversionEvent;
  hashedUserData: CanonicalHashedUserData;
  effectiveConsent: ConsentEnvelope;
  nowEpochSeconds?: number;
}

export type AdapterDispatchStatus =
  | "DISPATCHED"
  | "COOKIELESS_MODELING_PING"
  | "SUPPRESSED_DEDUP_WINDOW"
  | "SUPPRESSED_POSTBACK_EXPIRED"
  | "SUPPRESSED_CONSENT";

export interface AdapterDispatchDecision {
  platform: PlatformDestination;
  status: AdapterDispatchStatus;
  dedupKeyUsed: string;
  outboundPayload: Record<string, unknown> | null;
  httpStatus: number;
  vendorResponse: Record<string, unknown>;
  reason?: string;
}

export interface AdapterMutationResult {
  platform: PlatformDestination;
  account_id: string;
  campaign_id: string;
  status: "MUTATED" | "DRY_RUN_VALIDATED";
  outboundPayload: Record<string, unknown>;
  httpStatus: number;
  vendorResponse: Record<string, unknown>;
}

export interface PlatformAdapter {
  readonly platform: PlatformDestination;
  dispatchConversion(input: AdapterDispatchInput): Promise<AdapterDispatchDecision>;
  mutateBudget(request: BudgetMutationRequest): Promise<AdapterMutationResult>;
}
