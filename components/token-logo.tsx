"use client";

import { useEffect, useRef, useState } from "react";

import type { Token } from "@/config/tokens";
import { cn } from "@/lib/utils";

export type RemoteLogoProps = {
  // 이미지 URL. 없거나 로드에 실패하면 `label`의 첫 글자로 대체한다.
  src: string | undefined;
  label: string;
  className?: string;
  "data-testid"?: string;
};

// 원격 로고 이미지와 글자 대체. 접근성 이름에 섞이지 않도록 장식으로 숨긴다.
// 원격 로고 도메인을 고정할 수 없어 next/image 대신 img를 쓴다.
export function RemoteLogo({ src, label, className, "data-testid": testId }: RemoteLogoProps) {
  // 실패한 URL을 기억한다. URL이 바뀌면 다시 이미지를 시도한다.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const fallback = !src || failedSrc === src;
  const imageRef = useRef<HTMLImageElement>(null);

  // 서버 렌더링된 img는 하이드레이션 전에 로드가 실패하면 `onError`가 호출되지 않는다.
  // 마운트(또는 URL 변경) 시점에 이미 실패한 이미지인지 확인한다. 로딩 중이거나 로드된 이미지는 건드리지 않는다.
  useEffect(() => {
    const image = imageRef.current;
    if (!image || !src) return;
    if (!image.complete || image.naturalWidth > 0) return;

    let active = true;
    const markFailed = () => {
      if (active) setFailedSrc(src);
    };
    // 크기 정보가 없는 SVG도 naturalWidth가 0일 수 있어, decode가 실패할 때만 실패로 본다.
    if (typeof image.decode === "function") image.decode().catch(markFailed);
    else markFailed();
    return () => {
      active = false;
    };
  }, [src]);

  return (
    <span
      data-testid={testId}
      data-fallback={fallback ? "true" : "false"}
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-raised text-sm font-semibold text-primary",
        className,
      )}
    >
      {fallback ? (
        (Array.from(label)[0] ?? "")
      ) : (
        <img
          ref={imageRef}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}

// 토큰 로고. `logoURI`가 없거나 이미지 로드에 실패하면 심볼 첫 글자로 대체한다.
export function TokenLogo({
  token,
  className,
}: {
  token: Pick<Token, "symbol" | "logoURI">;
  className?: string;
}) {
  return (
    <RemoteLogo
      data-testid="token-logo"
      src={token.logoURI}
      label={token.symbol}
      className={className}
    />
  );
}
