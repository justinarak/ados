import { createHash } from "node:crypto";
import type { CanonicalHashedUserData } from "@ados/adapters";
import type { UserData } from "@ados/schemas";

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sha256Hex(value: string): string {
  if (SHA256_HEX_REGEX.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Normalizes an email address (trims whitespace, lowercases) prior to SHA-256 hashing.
 */
export function normalizeEmail(rawEmail: string): { normalized: string; valid: boolean } {
  const cleaned = rawEmail.trim().toLowerCase();
  if (SHA256_HEX_REGEX.test(cleaned)) {
    return { normalized: cleaned, valid: true };
  }
  return {
    normalized: cleaned,
    valid: EMAIL_REGEX.test(cleaned),
  };
}

/**
 * Normalizes a phone number into E.164 format (e.g. `+14155552671`) and digits-only for hashing.
 */
export function normalizePhoneE164(
  rawPhone: string,
  defaultCountryCode: string = "1"
): { e164: string; digitsOnly: string; valid: boolean } {
  const trimmed = rawPhone.trim();
  if (SHA256_HEX_REGEX.test(trimmed)) {
    return { e164: trimmed.toLowerCase(), digitsOnly: trimmed.toLowerCase(), valid: true };
  }

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length < 7 || digits.length > 15) {
    return { e164: `+${digits}`, digitsOnly: digits, valid: false };
  }

  let normalizedDigits = digits;
  if (!hasPlus && digits.length === 10 && defaultCountryCode === "1") {
    normalizedDigits = `1${digits}`;
  }

  return {
    e164: `+${normalizedDigits}`,
    digitsOnly: normalizedDigits,
    valid: normalizedDigits.length >= 10 && normalizedDigits.length <= 15,
  };
}

export interface CanonicalizedPIIResult {
  hashedUserData: CanonicalHashedUserData;
  normalizedPreview: {
    email?: string;
    phone_e164?: string;
  };
  warnings: string[];
}

/**
 * Inline Pre-Flight PII Canonicalizer & SHA-256 Hasher
 */
export function canonicalizeAndHashUserData(userData: UserData): CanonicalizedPIIResult {
  const warnings: string[] = [];
  const hashedUserData: CanonicalHashedUserData = {};
  const normalizedPreview: { email?: string; phone_e164?: string } = {};

  if (userData.email) {
    const { normalized, valid } = normalizeEmail(userData.email);
    if (!valid) {
      warnings.push(`Malformed email format detected: "${userData.email}"`);
    } else {
      normalizedPreview.email = normalized;
      hashedUserData.em = sha256Hex(normalized);
    }
  }

  if (userData.phone) {
    const { e164, digitsOnly, valid } = normalizePhoneE164(userData.phone);
    if (!valid) {
      warnings.push(`Malformed phone number for E.164 normalization: "${userData.phone}"`);
    } else {
      normalizedPreview.phone_e164 = e164;
      hashedUserData.ph = SHA256_HEX_REGEX.test(digitsOnly) ? digitsOnly : sha256Hex(digitsOnly);
    }
  }

  if (userData.first_name) {
    hashedUserData.fn = sha256Hex(userData.first_name.trim().toLowerCase());
  }
  if (userData.last_name) {
    hashedUserData.ln = sha256Hex(userData.last_name.trim().toLowerCase());
  }
  if (userData.city) {
    hashedUserData.ct = sha256Hex(userData.city.replace(/\s+/g, "").toLowerCase());
  }
  if (userData.state) {
    hashedUserData.st = sha256Hex(userData.state.trim().toLowerCase());
  }
  if (userData.zip_code) {
    hashedUserData.zp = sha256Hex(userData.zip_code.trim().toLowerCase());
  }
  if (userData.country) {
    hashedUserData.country = sha256Hex(userData.country.trim().toLowerCase());
  }
  if (userData.external_id) {
    hashedUserData.external_id = sha256Hex(userData.external_id.trim());
  }
  if (userData.client_ip_address) {
    hashedUserData.client_ip_address = userData.client_ip_address.trim();
  }
  if (userData.client_user_agent) {
    hashedUserData.client_user_agent = userData.client_user_agent.trim();
  }

  return {
    hashedUserData,
    normalizedPreview,
    warnings,
  };
}
