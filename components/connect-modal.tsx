"use client";

import { ChevronRightIcon, LoaderCircleIcon, ShieldCheckIcon, WalletIcon } from "lucide-react";
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";
import { useConnect, useConnectors } from "wagmi";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export const METAMASK_DOWNLOAD_URL = "https://metamask.io/download/";

type ConnectModalContextValue = {
  openConnectModal: () => void;
};

const ConnectModalContext = createContext<ConnectModalContextValue | null>(null);

export function useConnectModal(): ConnectModalContextValue {
  const value = useContext(ConnectModalContext);
  if (!value) throw new Error("useConnectModal must be used within ConnectModalProvider");
  return value;
}

// 지갑 버튼과 주 버튼이 같은 연결 모달 하나를 연다.
export function ConnectModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openConnectModal = useCallback(() => setOpen(true), []);
  const value = useMemo(() => ({ openConnectModal }), [openConnectModal]);

  return (
    <ConnectModalContext.Provider value={value}>
      {children}
      <ConnectModal open={open} onOpenChange={setOpen} />
    </ConnectModalContext.Provider>
  );
}

type ConnectModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function ConnectModal({ open, onOpenChange }: ConnectModalProps) {
  const connectors = useConnectors();
  const connect = useConnect();
  const isPending = connect.status === "pending";
  const pendingConnector = isPending ? connect.variables?.connector : undefined;

  const handleOpenChange = (nextOpen: boolean) => {
    // 다시 열 때 이전 시도의 오류 안내를 남기지 않는다.
    if (nextOpen) connect.reset();
    onOpenChange(nextOpen);
  };

  const handleSelect = (connector: (typeof connectors)[number]) => {
    connect.mutate(
      { connector },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid="connect-modal"
        className="gap-5 rounded-lg border border-border bg-surface p-6 break-keep ring-0 sm:max-w-md"
      >
        <div className="flex flex-col gap-2 pr-8">
          <DialogTitle className="text-xl font-semibold">지갑 연결</DialogTitle>
          <DialogDescription>내 지갑으로 가볍게 시작하세요.</DialogDescription>
        </div>

        {connectors.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {connectors.map((connector) => {
              const pending = connector === pendingConnector;
              return (
                <li key={connector.uid}>
                  <button
                    type="button"
                    data-testid="connector-option"
                    data-connector-id={connector.id}
                    data-pending={pending ? "true" : undefined}
                    aria-busy={pending || undefined}
                    disabled={isPending}
                    onClick={() => handleSelect(connector)}
                    className="flex w-full items-center gap-3 rounded-md border border-border bg-field p-3 text-left transition-colors outline-none hover:bg-raised focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 aria-busy:opacity-100"
                  >
                    <ConnectorIcon name={connector.name} icon={connector.icon} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-semibold">{connector.name}</span>
                      <span className="text-xs text-muted-foreground">감지됨</span>
                    </span>
                    {pending ? (
                      <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin" />
                    ) : (
                      <ChevronRightIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    {pending && <span className="sr-only">연결 중</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div
            data-testid="no-wallet-notice"
            className="flex flex-col items-center gap-2 py-6 text-center"
          >
            <WalletIcon aria-hidden className="mb-2 size-8 text-muted-foreground" />
            <p className="text-base font-medium">감지된 지갑이 없어요</p>
            <p className="text-sm text-muted-foreground">
              브라우저 지갑을 설치한 후 다시 확인해 주세요.
            </p>
            <a
              data-testid="install-wallet-link"
              href={METAMASK_DOWNLOAD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium text-primary transition-colors outline-none hover:bg-raised focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              MetaMask 설치
            </a>
          </div>
        )}

        {connect.status === "error" && (
          <p data-testid="connect-error" role="alert" className="text-sm text-error">
            지갑 연결이 완료되지 않았어요. 다시 시도해 주세요.
          </p>
        )}

        <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon aria-hidden className="size-3.5" />
          지갑 연결만으로 자산이 이동하지 않습니다.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function ConnectorIcon({ name, icon }: { name: string; icon: string | undefined }) {
  if (icon) {
    return <img src={icon} alt="" aria-hidden className="size-10 shrink-0 rounded-sm" />;
  }
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-raised text-lg font-semibold text-primary"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
