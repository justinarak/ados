import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import {
  type AdOSRole,
  type AdOSScope,
  type BudgetMutationRequest,
  type GuardrailPolicyRule,
  type PlatformDestination,
  ROLE_DEFAULT_SCOPES,
} from "@ados/schemas";

export interface GuardrailEvaluationResult {
  approved: boolean;
  policy_id: string;
  calculated_delta_percent?: number;
  violations: string[];
  requires_manual_approval: boolean;
}

/**
 * Evaluates a `BudgetMutationRequest` against an AdOS `GuardrailPolicyRule` (Section 6).
 * Enforces:
 * 1. Role & Scope Authorization (`campaigns.pacing:mutate`)
 * 2. Target Account Whitelisting
 * 3. Protected Campaign Blacklist & Manual Approval Tags (`tier1-unlimited`)
 * 4. Tier 1 Stateless Bounds (`min_daily_budget_micros`, `absolute_daily_cap_micros`, `rationale` length)
 * 5. Tier 2 Percentage Delta Limits (`max_increase_percent_per_call`, `max_decrease_percent_per_call`)
 */
export function evaluateBudgetGuardrails(
  request: BudgetMutationRequest,
  policy: GuardrailPolicyRule,
  lastMutationTimestampMs?: number,
  mutationsTodayCount: number = 0,
  nowMs: number = Date.now()
): GuardrailEvaluationResult {
  const violations: string[] = [];
  let requiresManualApproval = false;

  // 1. Scope & Role validation
  const effectiveScopes = new Set<AdOSScope>([
    ...policy.allowed_scopes,
    ...(policy.role ? ROLE_DEFAULT_SCOPES[policy.role] : []),
  ]);
  if (!effectiveScopes.has("campaigns.pacing:mutate")) {
    violations.push(
      `Subject "${policy.subject}" lacks required scope "campaigns.pacing:mutate"`
    );
  }

  // 2. Target account validation
  const allowedAccountsForPlatform = policy.target_accounts[request.platform];
  if (
    allowedAccountsForPlatform &&
    allowedAccountsForPlatform.length > 0 &&
    !allowedAccountsForPlatform.includes(request.account_id)
  ) {
    violations.push(
      `Account "${request.account_id}" on platform "${request.platform}" is not authorized under policy "${policy.id}"`
    );
  }

  // 3. Protected Entities & Manual Approval Tags
  const protectedEntities = policy.guardrails.protected_entities;
  if (protectedEntities.blocked_campaign_ids.includes(request.campaign_id)) {
    violations.push(
      `Campaign "${request.campaign_id}" is protected in blocked_campaign_ids and cannot be mutated programmatically`
    );
  }

  for (const tag of request.campaign_tags) {
    if (protectedEntities.require_manual_approval_tags.includes(tag)) {
      requiresManualApproval = true;
      violations.push(
        `Campaign carries tag "${tag}" which requires human-in-the-loop governor approval`
      );
    }
  }

  // 4. Tier 1 Stateless Payload Bounds
  const bounds = policy.guardrails.budget_bounds;
  if (bounds) {
    if (request.new_daily_budget_micros > bounds.absolute_daily_cap_micros) {
      violations.push(
        `new_daily_budget_micros (${request.new_daily_budget_micros}) exceeds absolute_daily_cap_micros (${bounds.absolute_daily_cap_micros})`
      );
    }
    if (request.new_daily_budget_micros < bounds.min_daily_budget_micros) {
      violations.push(
        `new_daily_budget_micros (${request.new_daily_budget_micros}) is below min_daily_budget_micros (${bounds.min_daily_budget_micros})`
      );
    }
    if (request.rationale.trim().length < bounds.require_rationale_min_length) {
      violations.push(
        `rationale must be at least ${bounds.require_rationale_min_length} characters for audit logging`
      );
    }
  }

  // 5. Tier 2 Percentage Delta Limits
  let calculatedDeltaPercent: number | undefined;
  const deltaLimits = policy.guardrails.budget_delta_limits;
  if (deltaLimits && request.current_daily_budget_micros) {
    const rawDelta =
      ((request.new_daily_budget_micros - request.current_daily_budget_micros) /
        request.current_daily_budget_micros) *
      100;
    calculatedDeltaPercent = Number(rawDelta.toFixed(2));

    if (
      calculatedDeltaPercent > 0 &&
      calculatedDeltaPercent > deltaLimits.max_increase_percent_per_call
    ) {
      violations.push(
        `Budget increase (+${calculatedDeltaPercent}%) exceeds max_increase_percent_per_call (+${deltaLimits.max_increase_percent_per_call}%)`
      );
    }
    if (
      calculatedDeltaPercent < 0 &&
      Math.abs(calculatedDeltaPercent) > deltaLimits.max_decrease_percent_per_call
    ) {
      violations.push(
        `Budget decrease (${calculatedDeltaPercent}%) exceeds max_decrease_percent_per_call (-${deltaLimits.max_decrease_percent_per_call}%)`
      );
    }
  }

  // 6. Tier 2 Cooldown & Daily Rate Limits
  const rateLimits = policy.guardrails.rate_limits;
  if (rateLimits) {
    if (lastMutationTimestampMs !== undefined) {
      const elapsedMinutes = (nowMs - lastMutationTimestampMs) / 60_000;
      if (elapsedMinutes < rateLimits.min_cooldown_minutes) {
        violations.push(
          `Cooldown violation: last mutation was ${elapsedMinutes.toFixed(
            1
          )}m ago (min_cooldown_minutes: ${rateLimits.min_cooldown_minutes}m)`
        );
      }
    }
    if (mutationsTodayCount >= rateLimits.max_mutations_per_day) {
      violations.push(
        `Daily mutation limit reached (${mutationsTodayCount}/${rateLimits.max_mutations_per_day} max_mutations_per_day)`
      );
    }
  }

  return {
    approved: violations.length === 0,
    policy_id: policy.id,
    calculated_delta_percent: calculatedDeltaPercent,
    violations,
    requires_manual_approval: requiresManualApproval,
  };
}

/**
 * Checks whether a unified role is authorized to perform a specific scope action.
 * Specifically enforces asymmetric state transitions (`campaigns.status:pause` vs `campaigns.status:activate`).
 */
export function isRoleAuthorizedForScope(role: AdOSRole, requiredScope: AdOSScope): boolean {
  return ROLE_DEFAULT_SCOPES[role].includes(requiredScope);
}

/**
 * Generates Meta's mandatory `appsecret_proof` (`HMAC-SHA256(access_token, app_secret)`)
 */
export function generateMetaAppSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

/**
 * AES-256-GCM Envelope Encryption Vault for Upstream Vendor "God Tokens"
 */
export class EncryptedTokenVault {
  private readonly masterKey: Buffer;

  constructor(masterKeyHexOrPassphrase: string) {
    if (/^[a-f0-9]{64}$/i.test(masterKeyHexOrPassphrase)) {
      this.masterKey = Buffer.from(masterKeyHexOrPassphrase, "hex");
    } else {
      this.masterKey = createHmac("sha256", "ados-vault-kdf")
        .update(masterKeyHexOrPassphrase)
        .digest();
    }
  }

  encryptToken(plainToken: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plainToken, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
  }

  decryptToken(envelopeString: string): string {
    const [ivHex, authTagHex, cipherHex] = envelopeString.split(":");
    if (!ivHex || !authTagHex || !cipherHex) {
      throw new Error("Invalid encrypted token envelope format");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.masterKey,
      Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(cipherHex, "hex")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }
}

export interface OAuthTokenPair {
  access_token: string;
  refresh_token: string;
  expires_at_ms: number;
}

export type OAuthRefreshFn = (
  platform: PlatformDestination,
  accountId: string,
  currentRefreshToken: string
) => Promise<OAuthTokenPair>;

/**
 * Single-Flight OAuth2 Refresh Coordinator (Section 6):
 * Prevents rotating refresh-token race conditions across concurrent gateway workers.
 * If 10 concurrent requests hit an expired (or <5m from expiry) token for `(platform, accountId)`,
 * only 1 upstream refresh call executes and all 10 requests resolve with the new token pair.
 */
export class SingleFlightOAuthCoordinator {
  private readonly tokenStore = new Map<string, OAuthTokenPair>();
  private readonly inFlightRefreshes = new Map<string, Promise<OAuthTokenPair>>();
  private readonly expiryBufferMs: number;

  constructor(
    private readonly refreshFn: OAuthRefreshFn,
    expiryBufferMs: number = 5 * 60 * 1000 // 5 minutes buffer before expiry
  ) {
    this.expiryBufferMs = expiryBufferMs;
  }

  seedToken(platform: PlatformDestination, accountId: string, token: OAuthTokenPair): void {
    this.tokenStore.set(`${platform}:${accountId}`, token);
  }

  async getValidAccessToken(
    platform: PlatformDestination,
    accountId: string,
    nowMs: number = Date.now()
  ): Promise<string> {
    const key = `${platform}:${accountId}`;
    const current = this.tokenStore.get(key);
    if (!current) {
      throw new Error(`No OAuth token registered for ${key}`);
    }

    if (nowMs + this.expiryBufferMs < current.expires_at_ms) {
      return current.access_token;
    }

    // Coalesce concurrent refreshes onto a single in-flight promise
    let inFlight = this.inFlightRefreshes.get(key);
    if (!inFlight) {
      inFlight = this.refreshFn(platform, accountId, current.refresh_token)
        .then((refreshed) => {
          this.tokenStore.set(key, refreshed);
          return refreshed;
        })
        .finally(() => {
          this.inFlightRefreshes.delete(key);
        });
      this.inFlightRefreshes.set(key, inFlight);
    }

    const updated = await inFlight;
    return updated.access_token;
  }
}
