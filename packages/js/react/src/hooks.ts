import * as React from "react";
import {
  OPENRECEIVE_COPY_FEEDBACK_MS,
  createOpenReceiveTickingValueController,
  createOpenReceiveTransientFeedbackController,
  type OpenReceiveTransientFeedbackController,
} from "@openreceive/browser/internal";

export function useOpenReceiveTransientValue<T>(
  resetValue: T,
  delayMs = OPENRECEIVE_COPY_FEEDBACK_MS,
): readonly [T, (value: T) => void] {
  const [value, setValue] = React.useState<T>(resetValue);
  const controller = React.useRef<OpenReceiveTransientFeedbackController<T> | null>(null);

  React.useEffect(() => {
    controller.current?.clear();
    controller.current = createOpenReceiveTransientFeedbackController({
      resetValue,
      delayMs,
      onValue: setValue,
    });
    return () => controller.current?.clear();
  }, [resetValue, delayMs]);

  const showValue = React.useCallback((nextValue: T) => {
    if (controller.current === null) {
      setValue(nextValue);
      return;
    }
    controller.current.show(nextValue);
  }, []);

  return [value, showValue];
}

export function useOpenReceiveTickingUnixSeconds(active: boolean): number | undefined {
  const [now, setNow] = React.useState<number | undefined>(undefined);
  React.useEffect(() => {
    if (!active) {
      setNow(undefined);
      return;
    }
    const controller = createOpenReceiveTickingValueController({
      onValue: setNow,
    });
    controller.start();
    return () => controller.stop();
  }, [active]);
  return now;
}
