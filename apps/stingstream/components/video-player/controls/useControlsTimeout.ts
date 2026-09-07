import { useCallback, useEffect, useRef } from "react";
import { controlsTimeoutForPlatform } from "./constants";

interface UseControlsTimeoutProps {
  showControls: boolean;
  isSliding: boolean;
  episodeView: boolean;
  onHideControls: () => void;
  timeout?: number;
  disabled?: boolean;
}

export const useControlsTimeout = ({
  showControls,
  isSliding,
  episodeView,
  onHideControls,
  // The default is the surface's own number rather than a shared 10 s, so a caller that does not
  // pass one behaves like the rest of the OSD instead of lingering more than twice as long.
  timeout = controlsTimeoutForPlatform(),
  disabled = false,
}: UseControlsTimeoutProps) => {
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const resetControlsTimeout = () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }

      if (!disabled && showControls && !isSliding && !episodeView) {
        controlsTimeoutRef.current = setTimeout(() => {
          onHideControls();
        }, timeout);
      }
    };

    resetControlsTimeout();

    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [showControls, isSliding, episodeView, timeout, onHideControls, disabled]);

  const handleControlsInteraction = useCallback(() => {
    if (disabled || !showControls) return;

    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      onHideControls();
    }, timeout);
  }, [disabled, showControls, onHideControls, timeout]);

  return {
    handleControlsInteraction,
  };
};
