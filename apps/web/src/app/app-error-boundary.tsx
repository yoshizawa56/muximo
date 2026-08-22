import { Component, type ErrorInfo, type PropsWithChildren } from "react";
import { AppErrorView } from "./app-error-view";

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled application render error", error, info);
  }

  render() {
    if (this.state.error) {
      return <AppErrorView error={this.state.error} onRetry={() => window.location.reload()} />;
    }

    return this.props.children;
  }
}
