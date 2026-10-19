import {
  type CreativeLintRequest,
  CreativeLintRequestSchema,
  type TargetPlacement,
} from "@ados/schemas";

export interface PlacementValidationResult {
  placement: TargetPlacement;
  passed: boolean;
  violations: string[];
}

export interface CreativeLintReport {
  valid: boolean;
  asset_url: string;
  media_type: "image" | "video";
  placement_results: PlacementValidationResult[];
  copy_violations: string[];
}

const VERTICAL_9_16_PLACEMENTS = new Set<TargetPlacement>([
  "meta_reels",
  "tiktok_feed",
  "youtube_shorts",
]);

/**
 * Quadrant 4: BYO-Storage Pre-Flight Creative Spec Linter (`ados_lint_creative`)
 * Inspects aspect ratios, durations, and ad copy character limits before making network calls.
 */
export function lintCreativeSpecs(input: CreativeLintRequest): CreativeLintReport {
  const req = CreativeLintRequestSchema.parse(input);
  const placementResults: PlacementValidationResult[] = [];
  const copyViolations: string[] = [];

  for (const placement of req.target_placements) {
    const violations: string[] = [];

    if (VERTICAL_9_16_PLACEMENTS.has(placement)) {
      if (req.media_type !== "video" && placement !== "meta_reels") {
        violations.push(`${placement} requires media_type="video"`);
      }
      if (req.width && req.height) {
        const ratio = req.width / req.height;
        const targetRatio = 9 / 16; // 0.5625
        if (Math.abs(ratio - targetRatio) > 0.03) {
          violations.push(
            `${placement} requires 9:16 vertical aspect ratio (received ${req.width}x${req.height})`
          );
        }
      }
      if (placement === "youtube_shorts" && req.duration_seconds && req.duration_seconds > 60) {
        violations.push(`youtube_shorts max duration is 60s (received ${req.duration_seconds}s)`);
      }
      if (placement === "tiktok_feed" && req.duration_seconds && req.duration_seconds < 5) {
        violations.push(`tiktok_feed minimum recommended video duration is 5s`);
      }
    }

    if (placement === "meta_feed" && req.width && req.height) {
      const ratio = req.width / req.height;
      // Meta Feed supports 1:1 (1.0) to 4:5 (0.8) or 1.91:1
      if (ratio < 0.79 || ratio > 1.92) {
        violations.push(
          `meta_feed aspect ratio must be between 4:5 (0.8) and 1.91:1 (received ${req.width}x${req.height})`
        );
      }
    }

    placementResults.push({
      placement,
      passed: violations.length === 0,
      violations,
    });
  }

  if (req.copy_variations) {
    const isGooglePmax = req.target_placements.includes("google_pmax");
    for (const headline of req.copy_variations.headlines) {
      if (isGooglePmax && headline.length > 30) {
        copyViolations.push(
          `google_pmax headline exceeds 30-char limit (${headline.length} chars): "${headline}"`
        );
      } else if (headline.length > 100) {
        copyViolations.push(`Headline exceeds 100-char limit (${headline.length} chars)`);
      }
    }
    for (const body of req.copy_variations.bodies) {
      if (isGooglePmax && body.length > 90) {
        copyViolations.push(
          `google_pmax body description exceeds 90-char limit (${body.length} chars)`
        );
      } else if (body.length > 500) {
        copyViolations.push(`Primary text exceeds 500-char limit (${body.length} chars)`);
      }
    }
  }

  const allPlacementsPassed = placementResults.every((r) => r.passed);
  return {
    valid: allPlacementsPassed && copyViolations.length === 0,
    asset_url: req.asset_url,
    media_type: req.media_type,
    placement_results: placementResults,
    copy_violations: copyViolations,
  };
}
