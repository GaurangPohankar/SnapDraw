/**
 * v2-ready sharing architecture.
 *
 * SnapDraw is deliberately local-only: this module defines the contract a
 * future (opt-in) sharing provider must implement, but the registry currently
 * exposes zero available providers and performs no network I/O. Adding a real
 * provider later means adding an object here – the editor UI already asks the
 * registry whether anything is available.
 */

/** Metadata handed to a provider together with the exported PNG. */
export interface ShareMeta {
  /** Suggested document title, e.g. `Screenshot 2026-11-07 21-55`. */
  title: string;
  /** Safe file name including the `.png` extension. */
  filename: string;
  width: number;
  height: number;
}

export interface ShareProvider {
  /** Stable identifier, e.g. `"local"`. */
  id: string;
  /** Short label rendered in the future share menu. */
  label: string;
  /** One line explaining where the image would go. */
  description: string;
  /**
   * Providers must opt in explicitly. Until the user configures one, nothing
   * may leave the device.
   */
  isAvailable(): boolean;
  /** Uploads/hands over the PNG. Only called when `isAvailable()` is true. */
  share(blob: Blob, meta: ShareMeta): Promise<void>;
}

export class ShareUnavailableError extends Error {
  readonly providerId: string;

  constructor(providerId: string, message: string) {
    super(message);
    this.name = "ShareUnavailableError";
    this.providerId = providerId;
  }
}

/**
 * The local provider is the only one SnapDraw ships with. It is intentionally
 * unavailable: v2 will turn it into an explicit "save/share on this device"
 * flow, but today Copy Image / Download PNG already cover that need.
 */
export const localShareProvider: ShareProvider = {
  id: "local",
  label: "This device",
  description: "Keep the annotated PNG on this computer.",
  isAvailable: () => false,
  share: async (_blob: Blob, _meta: ShareMeta): Promise<void> => {
    throw new ShareUnavailableError(
      "local",
      "Sharing from this device is not available yet.",
    );
  },
};

/** Every provider SnapDraw knows about. */
export const SHARE_PROVIDERS: readonly ShareProvider[] = [localShareProvider];

/** Providers the user could use right now (none, until v2). */
export function getAvailableShareProviders(): ShareProvider[] {
  return SHARE_PROVIDERS.filter((provider) => provider.isAvailable());
}

/** True when at least one provider can actually share the image. */
export function isSharingAvailable(): boolean {
  return getAvailableShareProviders().length > 0;
}
