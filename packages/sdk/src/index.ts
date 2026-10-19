import { AdOSGateway, type AdOSGatewayOptions } from "@ados/gateway";
import type {
  BudgetMutationRequest,
  CanonicalConversionEventInput,
  CreativeLintRequest,
  PlatformDestination,
  PrivacyPurgeRequest,
} from "@ados/schemas";

export class AdOSClient {
  private readonly gateway: AdOSGateway;

  constructor(options?: AdOSGatewayOptions) {
    this.gateway = new AdOSGateway(options);
  }

  lintConversion(event: CanonicalConversionEventInput) {
    return this.gateway.lintConversion(event);
  }

  dispatchConversion(event: CanonicalConversionEventInput, nowEpochSeconds?: number) {
    return this.gateway.dispatchConversion(event, nowEpochSeconds);
  }

  mutateBudget(request: BudgetMutationRequest) {
    return this.gateway.mutateBudget(request);
  }

  lintCreative(request: CreativeLintRequest) {
    return this.gateway.lintCreative(request);
  }

  querySignalHealth(accountId: string, platform: PlatformDestination, lookbackHours?: number) {
    return this.gateway.querySignalHealth(accountId, platform, lookbackHours);
  }

  purgeUser(request: PrivacyPurgeRequest) {
    return this.gateway.purgeUserIdentifier(request);
  }
}

export * from "@ados/schemas";
export * from "@ados/gateway";
