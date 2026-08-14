interface StartupUsageRefreshOptions {
  checkRefreshAll: () => Promise<boolean>;
  checkStaleQuotas: () => Promise<void>;
  onError: (error: unknown) => void;
}

export function startStartupUsageRefresh(options: StartupUsageRefreshOptions): void {
  void Promise.resolve()
    .then(async () => {
      const startedRefreshAll = await options.checkRefreshAll();
      if (!startedRefreshAll) await options.checkStaleQuotas();
    })
    .catch(options.onError);
}
