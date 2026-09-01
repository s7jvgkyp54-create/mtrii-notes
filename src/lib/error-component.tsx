import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { RecoveryScreen } from "@/components/notes/startup-ui";
import { startupMonitor } from "@/lib/notes/startup";

export function AppErrorComponent({ error }: ErrorComponentProps) {
  const parsed = useMemo(
    () => (error instanceof Error ? error : new Error(String(error))),
    [error],
  );
  useEffect(() => startupMonitor.fail(parsed), [parsed]);
  return <RecoveryScreen error={parsed} snapshot={startupMonitor.getSnapshot()} />;
}
