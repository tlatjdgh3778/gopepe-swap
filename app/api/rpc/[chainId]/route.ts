import type { NextRequest } from "next/server";

import { handleRpcProxyRequest } from "@/lib/rpc-proxy";

// 브라우저의 JSON-RPC 읽기 요청을 서버 전용 업체 RPC(실패 시 공개 RPC)로 전달한다.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/rpc/[chainId]">) {
  const { chainId } = await ctx.params;
  return handleRpcProxyRequest(request, chainId);
}
