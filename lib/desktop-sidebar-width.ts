export const SIDEBAR_COLLAPSED_WIDTH = 48;
export const SIDEBAR_DEFAULT_WIDTH = 240;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 520;
export const MAIN_MIN_WIDTH = 520;
export const SIDEBAR_RESIZE_HANDLE_WIDTH = 8;

interface ResolveSidebarWidthOptions {
  containerWidth?: number;
  currentPreference?: number;
  preserveWiderPreference?: boolean;
}

export function getSidebarMaxWidth(containerWidth?: number): number {
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    typeof containerWidth === "number" && Number.isFinite(containerWidth)
      ? Math.max(
          SIDEBAR_MIN_WIDTH,
          containerWidth - MAIN_MIN_WIDTH - SIDEBAR_RESIZE_HANDLE_WIDTH
        )
      : SIDEBAR_MAX_WIDTH
  );
}

export function clampSidebarPreference(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;

  return Math.round(
    Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH)
  );
}

export function resolveSidebarWidth(
  requestedWidth: number,
  {
    containerWidth,
    currentPreference,
    preserveWiderPreference = false,
  }: ResolveSidebarWidthOptions = {}
): { maxWidth: number; preference: number; width: number } {
  const maxWidth = getSidebarMaxWidth(containerWidth);
  const safeCurrentPreference =
    typeof currentPreference === "number"
      ? clampSidebarPreference(currentPreference)
      : undefined;
  let preference = clampSidebarPreference(requestedWidth);

  if (
    preserveWiderPreference &&
    typeof safeCurrentPreference === "number" &&
    safeCurrentPreference > maxWidth &&
    preference >= maxWidth
  ) {
    preference = Math.max(safeCurrentPreference, preference);
  }

  return {
    maxWidth,
    preference,
    width: Math.min(preference, maxWidth),
  };
}
