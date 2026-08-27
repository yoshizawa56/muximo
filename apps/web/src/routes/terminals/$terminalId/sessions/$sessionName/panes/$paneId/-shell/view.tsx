import { type ReactNode, useState } from "react";
import { CustomKeyboardSettingsView, CustomKeyboardView } from "../-custom-keyboard/view";
import type { CustomKeyboardSettingsViewModel, CustomKeyboardViewModel } from "../-custom-keyboard/viewmodel";

export type ShellViewModel = {
  keyboard: CustomKeyboardViewModel;
  keyboardSettings: CustomKeyboardSettingsViewModel;
};

export function ShellView({
  viewModel,
  terminalSurface,
  nativeKeyboard,
  initialSettingsOpen = false,
}: {
  viewModel: ShellViewModel;
  terminalSurface: ReactNode;
  nativeKeyboard: ReactNode;
  initialSettingsOpen?: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);

  if (settingsOpen) {
    return (
      <div className="h-[var(--app-viewport-height)] min-h-0 overflow-hidden bg-[#061008]">
        <CustomKeyboardSettingsView
          viewModel={viewModel.keyboardSettings}
          onClose={() => setSettingsOpen(false)}
          onSave={() => setSettingsOpen(false)}
        />
      </div>
    );
  }

  return (
    <main className="h-[var(--app-viewport-height)] min-h-0 bg-[#020503] p-2 pb-1 text-[#d9f4dc] md:p-6">
      <div className="mx-auto flex h-full max-w-[1100px] flex-col overflow-hidden rounded-[17px] border border-[#1c4b28] bg-[#071108] shadow-[0_25px_80px_rgb(0_0_0_/_46%)]">
        <header className="flex min-h-[54px] shrink-0 items-center gap-2 border-b border-[#17391f] bg-[rgb(6_15_8_/_95%)] px-3">
          <span className="size-2 rounded-full bg-[#39d65b] shadow-[0_0_0_4px_rgb(57_214_91_/_11%)]" />
          <span className="font-mono text-[0.58rem] font-bold uppercase tracking-[0.15em] text-[#6ba875]">
            Shell / mobile terminal
          </span>
        </header>
        <CustomKeyboardView
          viewModel={viewModel.keyboard}
          nativeKeyboard={nativeKeyboard}
          onOpenSettings={() => setSettingsOpen(true)}
        >
          {terminalSurface}
        </CustomKeyboardView>
      </div>
    </main>
  );
}
