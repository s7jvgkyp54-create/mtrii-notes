import { Component, type ErrorInfo, type ReactNode } from "react";
import { startupMonitor } from "@/lib/notes/startup";
import { RecoveryScreen } from "./startup-ui";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const enriched = new Error(error.message);
    enriched.name = error.name;
    enriched.stack = [error.stack, info.componentStack].filter(Boolean).join("\n");
    startupMonitor.fail(enriched);
  }

  render() {
    if (this.state.error) {
      return <RecoveryScreen error={this.state.error} snapshot={startupMonitor.getSnapshot()} />;
    }
    return this.props.children;
  }
}
